// MFT Indexer - builds a SQLite index of a whole NTFS volume from its MFT and answers queries on it.
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { getIndexDbPath, normalizeDriveLetter } from './drive';
import { extensionOf, resolveTypes } from './file-types';
import { createMFTParser } from './parser';
import { IndexScope, buildScope, isEmptyScope, nameInScope, pathInScope } from './scope';
import {
  EntryFilter,
  FileAttributes,
  FindCriteria,
  IndexOptions,
  IndexStats,
  LargestDirectory,
  MFTRecord,
  MFTRecordFlags,
  PAGE_SIZE,
  Page,
  IndexScopeInfo,
  ParsedRecord,
  SortOrder,
} from './types';

const SCHEMA_VERSION = 3;
const ROOT_RECORD = 5;
const YIELD_EVERY = 20000; // records between event-loop yields while scanning
const MAX_DEPTH = 4096; // guard against cyclic parent chains in a corrupt MFT

/** The subset of MFTParser the indexer needs (lets tests inject an in-memory volume). */
export interface ParserLike {
  scan(): Iterable<ParsedRecord>;
  close(): void;
}

export interface IndexerDeps {
  openParser?: (driveLetter: string) => ParserLike;
  dbPath?: string;
}

/**
 * Sizes are tracked per attribute "class" so that recursive directory sizes can be answered exactly for every
 * hidden/system filter combination: class = (Hidden ? 1 : 0) | (System ? 2 : 0).
 */
type ByClass = [number, number, number, number];
const zero = (): ByClass => [0, 0, 0, 0];
const attrClass = (attrs: number): number =>
  ((attrs & FileAttributes.HIDDEN) !== 0 ? 1 : 0) | ((attrs & FileAttributes.SYSTEM) !== 0 ? 2 : 0);

interface DirAcc {
  parent?: number;
  name?: string;
  size: ByClass; // bytes of files directly inside
  files: ByClass; // files directly inside
  treeSize: ByClass;
  treeFiles: ByClass;
}

/** Validate a 1-based page number coming from a CLI/MCP client (numbers or numeric strings). */
export function parsePage(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid page "${String(value)}": page must be an integer >= 1 (each page holds ${PAGE_SIZE} entries).`);
  }
  return n;
}

/** Escape LIKE wildcards; '^' is the escape character because '\' appears in Windows paths. */
function escapeLike(s: string): string {
  return s.replace(/[\^%_]/g, (c) => '^' + c);
}

export class MFTIndexer extends EventEmitter {
  readonly driveLetter: string;
  private db: Database.Database;
  private options: IndexOptions;
  private isIndexing = false;
  private openParser: (driveLetter: string) => ParserLike;

  constructor(driveLetter: string, options: IndexOptions = {}, deps: IndexerDeps = {}) {
    super();
    this.driveLetter = normalizeDriveLetter(driveLetter);
    this.options = {
      // A disk-usage index must contain everything (hiberfil.sys, pagefile.sys, swapfile.sys, $MFT, ... are
      // hidden+system files). Callers can opt out.
      includeHidden: true,
      includeSystem: true,
      batchSize: 1000,
      ...options,
      driveLetter: this.driveLetter,
    };
    this.openParser = deps.openParser ?? ((d) => createMFTParser(d));
    this.db = new Database(deps.dbPath ?? getIndexDbPath(this.driveLetter));
    this.initDatabase();
  }

  // ---- schema ------------------------------------------------------------------------------
  private initDatabase(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP VIEW IF EXISTS file_paths;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS meta;
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        record_number INTEGER PRIMARY KEY,
        sequence_number INTEGER NOT NULL,
        parent_record_number INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        dir_path TEXT,                       -- full path, directories only
        creation_time INTEGER,
        modification_time INTEGER,
        access_time INTEGER,
        mft_modification_time INTEGER,
        allocated_size INTEGER NOT NULL DEFAULT 0,
        real_size INTEGER NOT NULL DEFAULT 0,
        ext TEXT NOT NULL DEFAULT '',           -- lower-case extension without dot (files only)
        tree_size INTEGER NOT NULL DEFAULT 0,   -- directories: recursive size of all files below
        tree_files INTEGER NOT NULL DEFAULT 0,  -- directories: recursive file count
        -- directories: the same, split by attribute class (0 plain, 1 hidden, 2 system, 3 hidden+system)
        tree_size_c0 INTEGER NOT NULL DEFAULT 0, tree_size_c1 INTEGER NOT NULL DEFAULT 0,
        tree_size_c2 INTEGER NOT NULL DEFAULT 0, tree_size_c3 INTEGER NOT NULL DEFAULT 0,
        tree_files_c0 INTEGER NOT NULL DEFAULT 0, tree_files_c1 INTEGER NOT NULL DEFAULT 0,
        tree_files_c2 INTEGER NOT NULL DEFAULT 0, tree_files_c3 INTEGER NOT NULL DEFAULT 0,
        file_attributes INTEGER,
        flags INTEGER,
        is_directory INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Only directories store their path; a file's path is its parent's path + name.
      -- This keeps memory and disk use low and makes the scan single-pass.
      CREATE VIEW IF NOT EXISTS file_paths AS
        SELECT f.*,
               CASE WHEN f.is_directory = 1 THEN COALESCE(f.dir_path, f.file_name)
                    ELSE COALESCE(p.dir_path, '?') || '\\' || f.file_name END AS full_path
        FROM files f
        LEFT JOIN files p ON p.record_number = f.parent_record_number AND p.is_directory = 1;
    `);
    this.createIndexes();
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_parent ON files(parent_record_number);
      CREATE INDEX IF NOT EXISTS idx_name ON files(file_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_size ON files(real_size);
      CREATE INDEX IF NOT EXISTS idx_modified ON files(modification_time);
      CREATE INDEX IF NOT EXISTS idx_dir_tree ON files(is_directory, tree_size);
      CREATE INDEX IF NOT EXISTS idx_ext ON files(ext, real_size);
    `);
  }

  private dropIndexes(): void {
    this.db.exec(`
      DROP INDEX IF EXISTS idx_parent;
      DROP INDEX IF EXISTS idx_name;
      DROP INDEX IF EXISTS idx_size;
      DROP INDEX IF EXISTS idx_modified;
      DROP INDEX IF EXISTS idx_dir_tree;
      DROP INDEX IF EXISTS idx_ext;
    `);
  }

  // ---- indexing ----------------------------------------------------------------------------
  async index(overrides: IndexOptions = {}): Promise<IndexStats> {
    if (this.isIndexing) throw new Error('Indexing already in progress');
    const options = { ...this.options, ...stripUndefined(overrides), driveLetter: this.driveLetter };
    const batchSize = Math.max(1, options.batchSize || 1000);
    const startTime = Date.now();
    // Validate before flipping isIndexing: a bad --only/--exclude combination must not leave the
    // indexer permanently reporting "already in progress" on every later call.
    const scope = buildScope(this.driveLetter, options.only, options.exclude);
    this.isIndexing = true;
    let parser: ParserLike | undefined;
    try {
      // Opening the volume needs Administrator; do it before touching the database, so a failure
      // (including "not Windows" / "access denied") leaves the previous index intact. Doing this
      // inside try/finally (rather than before it) means isIndexing is always reset on failure too -
      // otherwise the indexer would be stuck reporting "already in progress" forever.
      parser = this.openParser(this.driveLetter);
      this.emit('start', { driveLetter: this.driveLetter, scope: scope.mode === 'none' ? undefined : { mode: scope.mode, entries: scope.raw } });
      this.db.pragma('synchronous = OFF');
      this.db.pragma('journal_mode = MEMORY');
      this.db.exec('DELETE FROM files; DELETE FROM meta;');
      this.dropIndexes();

      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO files
        (record_number, sequence_number, parent_record_number, file_name, ext,
         creation_time, modification_time, access_time, mft_modification_time,
         allocated_size, real_size, file_attributes, flags, is_directory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertOne = (r: ParsedRecord, isDir: boolean) =>
        insert.run(
          r.recordNumber, r.sequenceNumber, r.parentRecordNumber, r.fileName, isDir ? '' : extensionOf(r.fileName),
          r.creationTime.getTime(), r.modificationTime.getTime(),
          r.accessTime.getTime(), r.mftModificationTime.getTime(),
          Number(r.allocatedSize), Number(r.realSize),
          r.fileAttributes, r.flags, isDir ? 1 : 0
        );
      const insertBatch = this.db.transaction((batch: ParsedRecord[]) => {
        for (const r of batch) insertOne(r, (r.flags & MFTRecordFlags.DIRECTORY) !== 0);
      });

      const dirs = new Map<number, DirAcc>();
      const acc = (id: number): DirAcc => {
        let a = dirs.get(id);
        if (!a) dirs.set(id, (a = { size: zero(), files: zero(), treeSize: zero(), treeFiles: zero() }));
        return a;
      };
      // Size info for files whose $DATA lives in an extension record (seen before or after the base record).
      const sizeFixes = new Map<number, { real: bigint; alloc: bigint }>();
      // Directory records are always inserted immediately (needed to resolve every path, including
      // out-of-scope ones). File records are inserted immediately when scope has no path component
      // (the common, fast case: no scope, or a name-only pattern that needs no path knowledge) - or
      // held in `pending` when a path prefix is involved, since path membership can only be decided
      // once the file's ancestor chain of directory names is fully known.
      // A name pattern can match a DIRECTORY anywhere in a file's ancestor chain (e.g. "node_modules"),
      // not just the file's own name, so - like a path prefix - it can only be decided once every
      // directory's name and parent are known. Both therefore defer file records to `pending` and are
      // resolved together in a single pass over `dirs`, right after directory paths are built below.
      const needsScopeCheck = !isEmptyScope(scope);
      const pending: ParsedRecord[] = [];

      let totalFiles = 0;
      let totalDirectories = 0;
      let totalSize = 0;
      let scanned = 0;
      let batch: ParsedRecord[] = [];

      const flush = async () => {
        if (batch.length === 0) return;
        insertBatch(batch);
        batch = [];
        this.emit('progress', { files: totalFiles, directories: totalDirectories, size: String(totalSize) });
        await new Promise<void>((resolve) => setImmediate(resolve)); // keep the event loop (MCP pings) alive
      };

      /** Apply the file-accounting side effects (directory totals, running totals) for one kept file. */
      const account = (rec: ParsedRecord): void => {
        const size = Number(rec.realSize);
        const cls = attrClass(rec.fileAttributes);
        const p = acc(rec.parentRecordNumber);
        p.size[cls] += size;
        p.files[cls] += 1;
        totalFiles++;
        totalSize += size;
      };

      for (const rec of parser.scan()) {
        if (++scanned % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));

        if (rec.baseRecordNumber !== 0) {
          if (rec.hasSizedData) sizeFixes.set(rec.baseRecordNumber, { real: rec.realSize, alloc: rec.allocatedSize });
          continue;
        }
        if (!rec.fileName) continue;

        const isDirectory = (rec.flags & MFTRecordFlags.DIRECTORY) !== 0;
        if (isDirectory) {
          // Directories are always indexed and always kept for path building, in or out of scope:
          // children's paths (in or out of scope) depend on the full ancestor chain being known.
          const d = acc(rec.recordNumber);
          d.parent = rec.recordNumber === ROOT_RECORD ? undefined : rec.parentRecordNumber;
          d.name = rec.fileName;
          totalDirectories++;
          batch.push(rec);
          if (batch.length >= batchSize) await flush();
          continue;
        }

        if (!options.includeHidden && (rec.fileAttributes & FileAttributes.HIDDEN)) continue;
        if (!options.includeSystem && (rec.fileAttributes & FileAttributes.SYSTEM)) continue;

        if (needsScopeCheck) {
          pending.push(rec); // decided after directory paths are known, see below - no second MFT read needed
        } else {
          account(rec);
          batch.push(rec);
          if (batch.length >= batchSize) await flush();
        }
      }
      await flush();

      // -- sizes for files whose $DATA is in an extension record ---------------------------------
      // (applies to files inserted above; files still `pending` get their extension-record fix, if any,
      // applied together with their own insert below, via the same sizeFixes map.)
      if (sizeFixes.size > 0 && pending.length === 0) {
        const getFile = this.db.prepare('SELECT parent_record_number AS parent, real_size AS size, file_attributes AS attrs FROM files WHERE record_number = ? AND is_directory = 0');
        const setSize = this.db.prepare('UPDATE files SET real_size = ?, allocated_size = ? WHERE record_number = ?');
        this.db.transaction(() => {
          for (const [recordNumber, fix] of sizeFixes) {
            const row = getFile.get(recordNumber) as { parent: number; size: number; attrs: number } | undefined;
            if (!row) continue;
            const newSize = Number(fix.real);
            const delta = newSize - row.size;
            setSize.run(newSize, Number(fix.alloc), recordNumber);
            const p = acc(row.parent);
            p.size[attrClass(row.attrs)] += delta;
            totalSize += delta;
          }
        })();
      }

      // -- directory paths ---------------------------------------------------------------------
      const paths = new Map<number, string>();
      const rootPath = `${this.driveLetter}:`;
      const unknownPath = `${rootPath}\\<unknown>`;
      const resolvePath = (id: number): string => {
        const chain: number[] = [];
        let cur: number | undefined = id;
        let base: string | undefined;
        while (cur !== undefined) {
          const known = paths.get(cur);
          if (known !== undefined) { base = known; break; }
          if (cur === ROOT_RECORD) { base = rootPath; paths.set(cur, base); break; }
          const d = dirs.get(cur);
          if (!d || d.name === undefined || chain.length > MAX_DEPTH) { base = unknownPath; break; }
          chain.push(cur);
          cur = d.parent;
        }
        base = base ?? unknownPath;
        for (let i = chain.length - 1; i >= 0; i--) {
          base = base + '\\' + dirs.get(chain[i])!.name;
          paths.set(chain[i], base);
        }
        return paths.get(id) ?? base;
      };

      // -- resolve scoped files now that every directory's name/parent is known -----------------
      //
      // A directory is "flagged" if its own name matches a name pattern, or its resolved path matches a
      // path entry. Once every directory up to the root is checked once (memoized in `flagged`), a file's
      // scope membership is: its own name matches a pattern, OR any ancestor directory is flagged.
      const flagged = new Map<number, boolean>();
      const isFlaggedChain = (dirId: number | undefined): boolean => {
        let cur = dirId;
        const chain: number[] = [];
        let result = false;
        while (cur !== undefined) {
          const known = flagged.get(cur);
          if (known !== undefined) { result = known; break; }
          const d = dirs.get(cur);
          if (!d || d.name === undefined) break;
          if ((scope.namePatterns.length > 0 && nameInScope(scope, d.name)) || pathInScope(scope, resolvePath(cur))) {
            result = true;
            break;
          }
          chain.push(cur);
          cur = cur === ROOT_RECORD ? undefined : d.parent;
        }
        for (const id of chain) flagged.set(id, result);
        return result;
      };

      if (pending.length > 0) {
        const fix = sizeFixes;
        const pendingBatch = this.db.transaction((recs: ParsedRecord[]) => {
          for (const rec of recs) {
            const ownNameMatches = scope.namePatterns.length > 0 && nameInScope(scope, rec.fileName);
            const inScope = ownNameMatches || isFlaggedChain(rec.parentRecordNumber);
            const keep = scope.mode === 'only' ? inScope : !inScope;
            if (!keep) continue;
            const sizeFix = fix.get(rec.recordNumber);
            if (sizeFix) { rec.realSize = sizeFix.real; rec.allocatedSize = sizeFix.alloc; fix.delete(rec.recordNumber); }
            account(rec);
            insertOne(rec, false);
          }
        });
        pendingBatch(pending);
        this.emit('progress', { files: totalFiles, directories: totalDirectories, size: String(totalSize) });

        // any extension-record fix left over belongs to a file that was resolved (and inserted) above
        // before its fix arrived is impossible (fixes are applied at insert time here); remaining entries
        // are for files that were dropped by scope, or - if scope was empty - already handled earlier.
        if (fix.size > 0 && needsScopeCheck) {
          const getFile = this.db.prepare('SELECT parent_record_number AS parent, real_size AS size, file_attributes AS attrs FROM files WHERE record_number = ? AND is_directory = 0');
          const setSize = this.db.prepare('UPDATE files SET real_size = ?, allocated_size = ? WHERE record_number = ?');
          this.db.transaction(() => {
            for (const [recordNumber, sizeFix] of fix) {
              const row = getFile.get(recordNumber) as { parent: number; size: number; attrs: number } | undefined;
              if (!row) continue; // file was dropped by scope
              const newSize = Number(sizeFix.real);
              const delta = newSize - row.size;
              setSize.run(newSize, Number(sizeFix.alloc), recordNumber);
              const p = acc(row.parent);
              p.size[attrClass(row.attrs)] += delta;
              totalSize += delta;
            }
          })();
        }
      }

      // -- recursive directory sizes ---------------------------------------------------------------
      for (const [id, d] of dirs) {
        if (d.files.every((n) => n === 0) && d.size.every((n) => n === 0)) continue;
        let cur: number | undefined = id;
        for (let depth = 0; cur !== undefined && depth < MAX_DEPTH; depth++) {
          const a: DirAcc | undefined = dirs.get(cur);
          if (!a) break;
          for (let c = 0; c < 4; c++) {
            a.treeSize[c] += d.size[c];
            a.treeFiles[c] += d.files[c];
          }
          cur = cur === ROOT_RECORD ? undefined : a.parent;
        }
      }

      const setDir = this.db.prepare(`
        UPDATE files SET dir_path = ?, tree_size = ?, tree_files = ?,
          tree_size_c0 = ?, tree_size_c1 = ?, tree_size_c2 = ?, tree_size_c3 = ?,
          tree_files_c0 = ?, tree_files_c1 = ?, tree_files_c2 = ?, tree_files_c3 = ?
        WHERE record_number = ? AND is_directory = 1`);
      const sum = (a: ByClass) => a[0] + a[1] + a[2] + a[3];
      this.db.transaction(() => {
        for (const [id, d] of dirs) {
          if (d.name === undefined) continue; // parent referenced by a file but never seen as a directory
          setDir.run(resolvePath(id), sum(d.treeSize), sum(d.treeFiles), ...d.treeSize, ...d.treeFiles, id);
        }
      })();

      this.createIndexes();

      const stats: IndexStats = {
        totalFiles,
        totalDirectories,
        totalSize: BigInt(Math.max(0, Math.round(totalSize))),
        indexedAt: new Date(),
        duration: Date.now() - startTime,
        driveLetter: this.driveLetter,
        scope: scope.mode === 'none' ? undefined : { mode: scope.mode, entries: scope.raw },
      };
      this.saveStats(stats);
      this.emit('complete', stats);
      return stats;
    } finally {
      this.isIndexing = false;
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('journal_mode = DELETE');
      parser?.close();
    }
  }

  private saveStats(s: IndexStats): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    this.db.transaction(() => {
      put.run('totalFiles', String(s.totalFiles));
      put.run('totalDirectories', String(s.totalDirectories));
      put.run('totalSize', s.totalSize.toString());
      put.run('indexedAt', s.indexedAt.toISOString());
      put.run('duration', String(s.duration));
      put.run('scopeMode', s.scope?.mode ?? 'none');
      put.run('scopeEntries', JSON.stringify(s.scope?.entries ?? []));
    })();
  }

  // ---- queries -----------------------------------------------------------------------------
  /** True once a full index run has completed for this drive. */
  hasIndex(): boolean {
    return this.db.prepare("SELECT 1 FROM meta WHERE key = 'indexedAt'").get() !== undefined;
  }

  getStats(): IndexStats | null {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    if (rows.length === 0) return null;
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const scopeMode = (m.get('scopeMode') ?? 'none') as IndexScopeInfo['mode'];
    return {
      totalFiles: Number(m.get('totalFiles') ?? 0),
      totalDirectories: Number(m.get('totalDirectories') ?? 0),
      totalSize: BigInt(m.get('totalSize') ?? '0'),
      indexedAt: new Date(m.get('indexedAt') ?? 0),
      duration: Number(m.get('duration') ?? 0),
      driveLetter: this.driveLetter,
      scope: scopeMode === 'none' ? undefined : { mode: scopeMode, entries: JSON.parse(m.get('scopeEntries') ?? '[]') },
    };
  }

  // ---- paged queries -------------------------------------------------------------------------
  //
  // Nothing is ever truncated: every query returns one slice of PAGE_SIZE entries plus the total number
  // of matches, and the caller asks for page 2, 3, ... to see the rest. Ordering is fully deterministic
  // (ties are broken by record number) so pages never overlap or skip entries.
  //
  // Hidden/system filters look at the entry's OWN attributes. For directories they also change the
  // recursive size/file count: with includeHidden=false a directory's size excludes the hidden files below it.

  /** SQL conditions shared by all entry queries (hidden/system + file types). */
  private entryConditions(f: EntryFilter, params: unknown[]): string[] {
    const where: string[] = [];
    if (f.includeHidden === false) where.push(`(file_attributes & ${FileAttributes.HIDDEN}) = 0`);
    if (f.includeSystem === false) where.push(`(file_attributes & ${FileAttributes.SYSTEM}) = 0`);

    const { extensions, includeFolders } = resolveTypes(f.types);
    if (extensions.length > 0 || includeFolders) {
      const parts: string[] = [];
      if (extensions.length > 0) {
        parts.push(`(is_directory = 0 AND ext IN (${extensions.map(() => '?').join(', ')}))`);
        params.push(...extensions);
      }
      if (includeFolders) parts.push('is_directory = 1');
      where.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]);
    }
    return where;
  }

  private makePage<T>(items: T[], total: number, page: number): Page<T> {
    const offset = (page - 1) * PAGE_SIZE;
    return {
      items,
      total,
      page,
      pageSize: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE),
      offset,
      hasMore: offset + items.length < total,
    };
  }

  /** The general query behind search / size / date / largest-files. */
  find(criteria: FindCriteria, sort: SortOrder = 'relevance'): Page<MFTRecord> {
    const page = parsePage(criteria.page);
    const params: unknown[] = [];
    const conditions = this.entryConditions(criteria, params);

    const hasSize = criteria.minSize !== undefined || criteria.maxSize !== undefined;
    if (criteria.filesOnly || hasSize) conditions.push('is_directory = 0');
    if (criteria.minSize !== undefined) { conditions.push('real_size >= ?'); params.push(Number(criteria.minSize)); }
    if (criteria.maxSize !== undefined) { conditions.push('real_size <= ?'); params.push(Number(criteria.maxSize)); }
    if (criteria.after !== undefined) { conditions.push('modification_time >= ?'); params.push(criteria.after.getTime()); }
    if (criteria.before !== undefined) { conditions.push('modification_time <= ?'); params.push(criteria.before.getTime()); }

    let usesPath = false;
    const orderParams: unknown[] = [];
    let order = 'real_size DESC, record_number';
    const query = criteria.query;
    if (query !== undefined && query !== '') {
      usesPath = /[\\/]/.test(query);
      const q = usesPath ? query.replace(/\//g, '\\') : query;
      conditions.push(`${usesPath ? 'full_path' : 'file_name'} LIKE ? ESCAPE '^'`);
      params.push(`%${escapeLike(q)}%`);
      if (sort === 'relevance') {
        order = '(file_name = ? COLLATE NOCASE) DESC, real_size DESC, record_number';
        orderParams.push(q);
      }
    }
    if (sort === 'size') order = 'real_size DESC, record_number';
    if (sort === 'date') order = 'modification_time DESC, record_number';

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Counting only needs the (cheaper) table unless the path column is involved.
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${usesPath ? 'file_paths' : 'files'} ${whereSql}`)
      .get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM file_paths ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, ...orderParams, PAGE_SIZE, (page - 1) * PAGE_SIZE) as any[];
    return this.makePage(rows.map((row) => this.rowToRecord(row)), total, page);
  }

  /**
   * Search by name (substring, case-insensitive). If the query contains a path separator it is
   * matched against the full path instead. Exact name matches come first.
   */
  search(query: string, filter: EntryFilter = {}): Page<MFTRecord> {
    return this.find({ ...filter, query }, 'relevance');
  }

  /** Files within a size range (bytes, inclusive; either bound may be omitted). Largest first. */
  searchBySize(minSize: bigint | undefined, maxSize: bigint | undefined, filter: EntryFilter = {}): Page<MFTRecord> {
    return this.find({ ...filter, minSize, maxSize, filesOnly: true }, 'size');
  }

  /** Entries modified within a time range (inclusive; either bound may be omitted). Newest first. */
  searchByDate(after: Date | undefined, before: Date | undefined, filter: EntryFilter = {}): Page<MFTRecord> {
    return this.find({ ...filter, after, before }, 'date');
  }

  getLargestFiles(filter: EntryFilter = {}): Page<MFTRecord> {
    return this.find({ ...filter, filesOnly: true }, 'size');
  }

  /**
   * Largest directories by recursive size, biggest first (the drive root itself and directories that
   * contain no files are excluded). `types` is ignored here.
   */
  getLargestDirectories(filter: EntryFilter = {}): Page<LargestDirectory> {
    const page = parsePage(filter.page);
    // Which attribute classes count towards a directory's size for this filter (see ByClass).
    const classes = [0];
    if (filter.includeHidden !== false) classes.push(1);
    if (filter.includeSystem !== false) classes.push(2);
    if (filter.includeHidden !== false && filter.includeSystem !== false) classes.push(3);
    const sizeExpr = classes.length === 4 ? 'tree_size' : classes.map((c) => `tree_size_c${c}`).join(' + ');
    const filesExpr = classes.length === 4 ? 'tree_files' : classes.map((c) => `tree_files_c${c}`).join(' + ');

    const conditions = ['is_directory = 1', 'record_number != ?', 'dir_path IS NOT NULL', `(${filesExpr}) > 0`];
    if (filter.includeHidden === false) conditions.push(`(file_attributes & ${FileAttributes.HIDDEN}) = 0`);
    if (filter.includeSystem === false) conditions.push(`(file_attributes & ${FileAttributes.SYSTEM}) = 0`);
    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM files ${whereSql}`).get(ROOT_RECORD) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT record_number, dir_path, (${sizeExpr}) AS size, (${filesExpr}) AS file_count FROM files ${whereSql}
         ORDER BY (${sizeExpr}) DESC, record_number LIMIT ? OFFSET ?`
      )
      .all(ROOT_RECORD, PAGE_SIZE, (page - 1) * PAGE_SIZE) as any[];
    return this.makePage(
      rows.map((r) => ({ recordNumber: r.record_number, path: r.dir_path, size: BigInt(r.size), fileCount: r.file_count })),
      total,
      page
    );
  }

  getDatabasePath(): string {
    return this.db.name;
  }

  /** Closes the database. (The volume is opened and closed inside index().) */
  close(): void {
    if (this.db.open) this.db.close();
  }

  private rowToRecord(row: any): MFTRecord {
    return {
      recordNumber: row.record_number,
      sequenceNumber: row.sequence_number,
      flags: row.flags,
      linkCount: 1,
      attributeOffset: 0,
      fileName: row.file_name,
      fullPath: row.full_path,
      parentRecordNumber: row.parent_record_number,
      creationTime: new Date(row.creation_time),
      modificationTime: new Date(row.modification_time),
      accessTime: new Date(row.access_time),
      mftModificationTime: new Date(row.mft_modification_time),
      allocatedSize: BigInt(row.allocated_size),
      realSize: BigInt(row.real_size),
      fileAttributes: row.file_attributes,
    };
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function createIndexer(driveLetter: string, options?: IndexOptions, deps?: IndexerDeps): MFTIndexer {
  return new MFTIndexer(driveLetter, options, deps);
}