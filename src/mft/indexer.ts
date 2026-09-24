// MFT Indexer - builds a SQLite index of a whole NTFS volume from its MFT and answers queries on it.
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { getIndexDbPath, normalizeDriveLetter } from './drive';
import { createMFTParser } from './parser';
import {
  FileAttributes,
  IndexOptions,
  IndexStats,
  LargestDirectory,
  MFTRecord,
  MFTRecordFlags,
  ParsedRecord,
} from './types';

const SCHEMA_VERSION = 2;
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

interface DirAcc {
  parent?: number;
  name?: string;
  size: number; // bytes of files directly inside
  files: number; // files directly inside
  treeSize: number;
  treeFiles: number;
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
        tree_size INTEGER NOT NULL DEFAULT 0,   -- directories: recursive size of all files below
        tree_files INTEGER NOT NULL DEFAULT 0,  -- directories: recursive file count
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
    `);
  }

  private dropIndexes(): void {
    this.db.exec(`
      DROP INDEX IF EXISTS idx_parent;
      DROP INDEX IF EXISTS idx_name;
      DROP INDEX IF EXISTS idx_size;
      DROP INDEX IF EXISTS idx_modified;
      DROP INDEX IF EXISTS idx_dir_tree;
    `);
  }

  // ---- indexing ----------------------------------------------------------------------------
  async index(overrides: IndexOptions = {}): Promise<IndexStats> {
    if (this.isIndexing) throw new Error('Indexing already in progress');
    this.isIndexing = true;
    const options = { ...this.options, ...stripUndefined(overrides), driveLetter: this.driveLetter };
    const batchSize = Math.max(1, options.batchSize || 1000);
    const startTime = Date.now();

    // Opening the volume needs Administrator; do it first so a failure leaves the old index intact.
    const parser = this.openParser(this.driveLetter);
    try {
      this.emit('start', { driveLetter: this.driveLetter });
      this.db.pragma('synchronous = OFF');
      this.db.pragma('journal_mode = MEMORY');
      this.db.exec('DELETE FROM files; DELETE FROM meta;');
      this.dropIndexes();

      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO files
        (record_number, sequence_number, parent_record_number, file_name,
         creation_time, modification_time, access_time, mft_modification_time,
         allocated_size, real_size, file_attributes, flags, is_directory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertBatch = this.db.transaction((batch: ParsedRecord[]) => {
        for (const r of batch) {
          insert.run(
            r.recordNumber, r.sequenceNumber, r.parentRecordNumber, r.fileName,
            r.creationTime.getTime(), r.modificationTime.getTime(),
            r.accessTime.getTime(), r.mftModificationTime.getTime(),
            Number(r.allocatedSize), Number(r.realSize),
            r.fileAttributes, r.flags, (r.flags & MFTRecordFlags.DIRECTORY) !== 0 ? 1 : 0
          );
        }
      });

      const dirs = new Map<number, DirAcc>();
      const acc = (id: number): DirAcc => {
        let a = dirs.get(id);
        if (!a) dirs.set(id, (a = { size: 0, files: 0, treeSize: 0, treeFiles: 0 }));
        return a;
      };
      // Size info for files whose $DATA lives in an extension record (seen before or after the base record).
      const sizeFixes = new Map<number, { real: bigint; alloc: bigint }>();

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

      for (const rec of parser.scan()) {
        if (++scanned % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));

        if (rec.baseRecordNumber !== 0) {
          if (rec.hasSizedData) sizeFixes.set(rec.baseRecordNumber, { real: rec.realSize, alloc: rec.allocatedSize });
          continue;
        }
        if (!rec.fileName) continue;

        const isDirectory = (rec.flags & MFTRecordFlags.DIRECTORY) !== 0;
        if (isDirectory) {
          // Directories are always indexed: children's paths depend on them.
          const d = acc(rec.recordNumber);
          d.parent = rec.recordNumber === ROOT_RECORD ? undefined : rec.parentRecordNumber;
          d.name = rec.fileName;
          totalDirectories++;
        } else {
          if (!options.includeHidden && (rec.fileAttributes & FileAttributes.HIDDEN)) continue;
          if (!options.includeSystem && (rec.fileAttributes & FileAttributes.SYSTEM)) continue;
          const size = Number(rec.realSize);
          const p = acc(rec.parentRecordNumber);
          p.size += size;
          p.files += 1;
          totalFiles++;
          totalSize += size;
        }

        batch.push(rec);
        if (batch.length >= batchSize) await flush();
      }
      await flush();

      // -- sizes for files whose $DATA is in an extension record ---------------------------------
      if (sizeFixes.size > 0) {
        const getFile = this.db.prepare('SELECT parent_record_number AS parent, real_size AS size FROM files WHERE record_number = ? AND is_directory = 0');
        const setSize = this.db.prepare('UPDATE files SET real_size = ?, allocated_size = ? WHERE record_number = ?');
        this.db.transaction(() => {
          for (const [recordNumber, fix] of sizeFixes) {
            const row = getFile.get(recordNumber) as { parent: number; size: number } | undefined;
            if (!row) continue;
            const newSize = Number(fix.real);
            const delta = newSize - row.size;
            setSize.run(newSize, Number(fix.alloc), recordNumber);
            const p = acc(row.parent);
            p.size += delta;
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

      // -- recursive directory sizes ---------------------------------------------------------------
      for (const [id, d] of dirs) {
        if (d.files === 0 && d.size === 0) continue;
        let cur: number | undefined = id;
        for (let depth = 0; cur !== undefined && depth < MAX_DEPTH; depth++) {
          const a: DirAcc | undefined = dirs.get(cur);
          if (!a) break;
          a.treeSize += d.size;
          a.treeFiles += d.files;
          cur = cur === ROOT_RECORD ? undefined : a.parent;
        }
      }

      const setDir = this.db.prepare('UPDATE files SET dir_path = ?, tree_size = ?, tree_files = ? WHERE record_number = ? AND is_directory = 1');
      this.db.transaction(() => {
        for (const [id, d] of dirs) {
          if (d.name === undefined) continue; // parent referenced by a file but never seen as a directory
          setDir.run(resolvePath(id), d.treeSize, d.treeFiles, id);
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
      };
      this.saveStats(stats);
      this.emit('complete', stats);
      return stats;
    } finally {
      this.isIndexing = false;
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('journal_mode = DELETE');
      parser.close();
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
    return {
      totalFiles: Number(m.get('totalFiles') ?? 0),
      totalDirectories: Number(m.get('totalDirectories') ?? 0),
      totalSize: BigInt(m.get('totalSize') ?? '0'),
      indexedAt: new Date(m.get('indexedAt') ?? 0),
      duration: Number(m.get('duration') ?? 0),
      driveLetter: this.driveLetter,
    };
  }

  /**
   * Search by name (substring, case-insensitive). If the query contains a path separator it is
   * matched against the full path instead.
   */
  search(query: string, limit: number = 100): MFTRecord[] {
    const byPath = /[\\/]/.test(query);
    const q = byPath ? query.replace(/\//g, '\\') : query;
    const column = byPath ? 'full_path' : 'file_name';
    const rows = this.db
      .prepare(
        `SELECT * FROM file_paths
         WHERE ${column} LIKE ? ESCAPE '^'
         ORDER BY (file_name = ? COLLATE NOCASE) DESC, real_size DESC
         LIMIT ?`
      )
      .all(`%${escapeLike(q)}%`, q, limit) as any[];
    return rows.map((row) => this.rowToRecord(row));
  }

  searchBySize(minSize: bigint, maxSize: bigint, limit: number = 100): MFTRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM file_paths WHERE is_directory = 0 AND real_size >= ? AND real_size <= ?
         ORDER BY real_size DESC LIMIT ?`
      )
      .all(Number(minSize), Number(maxSize), limit) as any[];
    return rows.map((row) => this.rowToRecord(row));
  }

  searchByDate(after: Date, before: Date, limit: number = 100): MFTRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM file_paths WHERE modification_time >= ? AND modification_time <= ?
         ORDER BY modification_time DESC LIMIT ?`
      )
      .all(after.getTime(), before.getTime(), limit) as any[];
    return rows.map((row) => this.rowToRecord(row));
  }

  getLargestFiles(limit: number = 50): MFTRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM file_paths WHERE is_directory = 0 ORDER BY real_size DESC LIMIT ?')
      .all(limit) as any[];
    return rows.map((row) => this.rowToRecord(row));
  }

  /** Largest directories by recursive size (the drive root itself is excluded). */
  getLargestDirectories(limit: number = 50): LargestDirectory[] {
    const rows = this.db
      .prepare(
        `SELECT record_number, dir_path, tree_size, tree_files FROM files
         WHERE is_directory = 1 AND record_number != ? AND dir_path IS NOT NULL
         ORDER BY tree_size DESC LIMIT ?`
      )
      .all(ROOT_RECORD, limit) as any[];
    return rows.map((r) => ({
      recordNumber: r.record_number,
      path: r.dir_path,
      size: BigInt(r.tree_size),
      fileCount: r.tree_files,
    }));
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