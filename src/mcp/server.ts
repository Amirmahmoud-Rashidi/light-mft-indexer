// MCP Server - Model Context Protocol server for file operations
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MFTIndexer, createIndexer } from '../mft/indexer';
import { normalizeDriveLetter } from '../mft/drive';
import { FILE_TYPE_CATEGORIES, FOLDER_TYPE, listCategories } from '../mft/file-types';
import { parseBool, parseDate, parseFilter, parseSize } from '../mft/args';
import { EntryFilter, FileAttributes, IndexOptions, MFTRecord, PAGE_SIZE, Page } from '../mft/types';
import { DiskReporter, createDiskReporter } from '../reporter';

const TYPES_DESCRIPTION =
  `Only return these file types (OR-combined). Presets: ${listCategories().join(', ')}; "${FOLDER_TYPE}" = directories. ` +
  `For any other format pass its extension, e.g. "mkv", ".psd" or "*.xyz". ` +
  `Example: ["video", "iso", ".xyz"]. Omit for all types. Use the list_file_types tool to see what each preset contains.`;

const HIDDEN_DESCRIPTION = 'Include entries that have the Hidden attribute (default true). Set false to hide them.';
const SYSTEM_DESCRIPTION =
  'Include entries that have the System attribute, e.g. hiberfil.sys, pagefile.sys, $MFT (default true). Set false to hide them.';
const PAGE_DESCRIPTION =
  `Page number, 1-based (default 1). Results are never cut off: each page holds ${PAGE_SIZE} entries, and the answer ` +
  `states the total and whether another page exists - call again with page=2, 3, ... to continue.`;

const DRIVE_PROP = { type: 'string', description: 'Drive letter, e.g. "C"' };
const FILTER_PROPS = {
  types: { type: 'array', items: { type: 'string' }, description: TYPES_DESCRIPTION },
  includeHidden: { type: 'boolean', default: true, description: HIDDEN_DESCRIPTION },
  includeSystem: { type: 'boolean', default: true, description: SYSTEM_DESCRIPTION },
  page: { type: 'integer', minimum: 1, default: 1, description: PAGE_DESCRIPTION },
};
const SIZE_DESCRIPTION = 'Size in bytes ("1048576") or with a unit ("500MB", "1.5GB"; units are 1024-based).';
const DATE_DESCRIPTION =
  'ISO 8601 date/time, e.g. "2025-01-31" or "2025-01-31T12:00:00Z". Dates without a time are UTC; for "before" a bare date means the END of that day.';

export class MFTMCPServer {
  private server: Server;
  private indexers: Map<string, MFTIndexer> = new Map();
  private diskReporter: DiskReporter;

  constructor() {
    this.server = new Server(
      {
        name: 'mft-indexer',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.diskReporter = createDiskReporter();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'index_drive',
          description: 'Index an NTFS drive by reading its MFT (needs Administrator rights; can take from seconds to a few minutes). Must be run once before any search on that drive. Leave includeHidden/includeSystem at their default (true): hidden and system files are filtered at search time instead.',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string', description: 'Drive letter (e.g., "C")' },
              includeHidden: { type: 'boolean', default: true, description: 'Index hidden files (default true)' },
              includeSystem: { type: 'boolean', default: true, description: 'Index system files such as hiberfil.sys and pagefile.sys (default true)' },
              batchSize: { type: 'number', default: 1000 },
              only: {
                type: 'array', items: { type: 'string' },
                description:
                  'Only index these paths (with everything below them) and/or name patterns (e.g. "C:\\Projects", "*.iso"). ' +
                  'Use for a drive too large to fully index, or when only a few locations matter: much smaller and faster to query than a full index. ' +
                  'Cannot be combined with exclude.',
              },
              exclude: {
                type: 'array', items: { type: 'string' },
                description:
                  'Skip these paths (with everything below them) and/or name patterns (e.g. "node_modules", "*.tmp"). Cannot be combined with only.',
              },
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'search_files',
          description:
            'General search. Matches a name substring (case-insensitive; if the text contains \\ or / it is matched against the full path) ' +
            'and/or combines any filters: file types, size range, modification-date range, hidden/system. ' +
            'Exact name matches come first, then largest first. Never truncated: paged, 50 entries per page.',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: DRIVE_PROP,
              query: { type: 'string', description: 'Name (or path) text to look for. Optional when other filters are given.' },
              minSize: { type: 'string', description: 'Minimum file size. ' + SIZE_DESCRIPTION },
              maxSize: { type: 'string', description: 'Maximum file size. ' + SIZE_DESCRIPTION },
              after: { type: 'string', description: 'Modified on/after. ' + DATE_DESCRIPTION },
              before: { type: 'string', description: 'Modified on/before. ' + DATE_DESCRIPTION },
              ...FILTER_PROPS,
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'search_by_size',
          description:
            'Files within a size range (either bound optional), largest first. Never truncated: paged, 50 entries per page.',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: DRIVE_PROP,
              minSize: { type: 'string', description: 'Minimum size. ' + SIZE_DESCRIPTION },
              maxSize: { type: 'string', description: 'Maximum size. ' + SIZE_DESCRIPTION },
              ...FILTER_PROPS,
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'search_by_date',
          description:
            'Entries modified within a date range (either bound optional), newest first. Never truncated: paged, 50 entries per page.',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: DRIVE_PROP,
              after: { type: 'string', description: 'Modified on/after. ' + DATE_DESCRIPTION },
              before: { type: 'string', description: 'Modified on/before. ' + DATE_DESCRIPTION },
              ...FILTER_PROPS,
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'get_largest_files',
          description: 'All files ordered by size, largest first. Paged, 50 entries per page.',
          inputSchema: {
            type: 'object',
            properties: { driveLetter: DRIVE_PROP, ...FILTER_PROPS },
            required: ['driveLetter'],
          },
        },
        {
          name: 'get_largest_directories',
          description:
            'Directories ordered by recursive size (all files below them), largest first. With includeHidden/includeSystem = false ' +
            'the sizes also exclude hidden/system files. Paged, 50 entries per page.',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: DRIVE_PROP,
              includeHidden: FILTER_PROPS.includeHidden,
              includeSystem: FILTER_PROPS.includeSystem,
              page: FILTER_PROPS.page,
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'get_disk_usage',
          description: 'Get disk usage report for a drive',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'get_index_stats',
          description: 'Get indexing statistics for a drive',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'list_file_types',
          description: 'Show the preset file-type categories (and the extensions in each) usable in the "types" filter.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'list_drives',
          description: 'List all available drives',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'index_drive':
            return await this.handleIndexDrive(args);
          case 'search_files':
            return await this.handleSearchFiles(args);
          case 'search_by_size':
            return await this.handleSearchBySize(args);
          case 'search_by_date':
            return await this.handleSearchByDate(args);
          case 'get_largest_files':
            return await this.handleGetLargestFiles(args);
          case 'get_largest_directories':
            return await this.handleGetLargestDirectories(args);
          case 'get_disk_usage':
            return await this.handleGetDiskUsage(args);
          case 'get_index_stats':
            return await this.handleGetIndexStats(args);
          case 'list_file_types':
            return this.handleListFileTypes();
          case 'list_drives':
            return await this.handleListDrives();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });

    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'mft://drives',
          name: 'Available Drives',
          description: 'List of all available drives',
          mimeType: 'application/json',
        },
      ],
    }));

    // Read resources
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      
      if (uri === 'mft://drives') {
        const drives = this.diskReporter.getDrives();
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            // JSON.stringify cannot serialize bigint; sizes are emitted as decimal strings.
            text: JSON.stringify(drives, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
          }],
        };
      }
      
      throw new Error(`Unknown resource: ${uri}`);
    });
  }

  private getOrCreateIndexer(driveLetter: string, options?: IndexOptions): MFTIndexer {
    const key = normalizeDriveLetter(driveLetter);
    let indexer = this.indexers.get(key);
    if (!indexer) {
      indexer = createIndexer(key, options);
      this.indexers.set(key, indexer);
    }
    return indexer;
  }

  /** Indexer for a drive that must already have been indexed (search tools never need Administrator). */
  private getIndexedIndexer(driveLetter: string): MFTIndexer {
    const indexer = this.getOrCreateIndexer(driveLetter);
    if (!indexer.hasIndex()) {
      throw new Error(
        `Drive ${normalizeDriveLetter(driveLetter)}: has not been indexed yet. Run the index_drive tool first (requires Administrator).`
      );
    }
    return indexer;
  }

  private text(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  private formatRecord(r: MFTRecord): string {
    const isDir = (r.flags & 0x02) !== 0;
    const tags =
      ((r.fileAttributes & FileAttributes.HIDDEN) !== 0 ? ' [hidden]' : '') +
      ((r.fileAttributes & FileAttributes.SYSTEM) !== 0 ? ' [system]' : '');
    const size = isDir ? '' : ` (${this.formatBytes(r.realSize)})`;
    return `${isDir ? '[DIR] ' : ''}${r.fullPath ?? r.fileName}${size}${tags} - modified ${r.modificationTime.toISOString()}`;
  }

  /** One-line description of the non-default filters, so the answer shows exactly what was applied. */
  private describeFilter(f: EntryFilter, extra: string[] = []): string {
    const parts = [...extra];
    if (f.types && f.types.length > 0) parts.push(`types=${f.types.join(',')}`);
    if (f.includeHidden === false) parts.push('hidden excluded');
    if (f.includeSystem === false) parts.push('system excluded');
    return parts.length > 0 ? `Filters: ${parts.join('; ')}\n` : '';
  }

  /** Common answer layout for every paged result: summary line, numbered entries, how to get the next page. */
  private formatPage<T>(what: 'entries' | 'files' | 'directories', page: Page<T>, filters: string, line: (item: T) => string, tool: string): string {
    if (page.total === 0) return `${filters}No ${what} found.`;
    if (page.items.length === 0) {
      return `${filters}Page ${page.page} is past the end: there are only ${page.totalPages} page(s) (${page.total.toLocaleString()} ${what}, ${PAGE_SIZE} per page).`;
    }
    const first = page.offset + 1;
    const last = page.offset + page.items.length;
    const noun = page.total === 1 ? { entries: 'entry', files: 'file', directories: 'directory' }[what] ?? what : what;
    const range = first === last ? `${first.toLocaleString()}` : `${first.toLocaleString()}-${last.toLocaleString()}`;
    const lines = page.items.map((item, i) => `${first + i}. ${line(item)}`).join('\n');
    const next = page.hasMore
      ? `\n\nMore results: call ${tool} again with page=${page.page + 1} (${(page.total - last).toLocaleString()} more).`
      : '\n\n(End of results.)';
    return (
      `${filters}Found ${page.total.toLocaleString()} ${noun}. Showing ${range} ` +
      `(page ${page.page} of ${page.totalPages}).\n\n${lines}${next}`
    );
  }

  private async handleIndexDrive(args: any) {
    const { driveLetter, includeHidden, includeSystem, batchSize, only, exclude } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const stats = await indexer.index({ includeHidden, includeSystem, batchSize, only, exclude });

    return this.text(
      `Indexing complete for ${stats.driveLetter}:\n` +
        (stats.scope ? `Scope: ${stats.scope.mode} ${stats.scope.entries.map((e) => `"${e}"`).join(', ')}\n` : '') +
        `Files: ${stats.totalFiles.toLocaleString()}\n` +
        `Directories: ${stats.totalDirectories.toLocaleString()}\n` +
        `Total Size: ${this.formatBytes(stats.totalSize)}\n` +
        `Duration: ${stats.duration}ms\n` +
        `Indexed at: ${stats.indexedAt.toISOString()}`
    );
  }

  private async handleSearchFiles(args: any) {
    const { driveLetter } = args;
    const filter = parseFilter(args);
    const minSize = parseSize('minSize', args.minSize);
    const maxSize = parseSize('maxSize', args.maxSize);
    const after = parseDate('after', args.after);
    const before = parseDate('before', args.before, true);
    const query = args.query === undefined || args.query === null ? undefined : String(args.query);

    const page = this.getIndexedIndexer(driveLetter).find({ ...filter, query, minSize, maxSize, after, before }, 'relevance');
    const applied: string[] = [];
    if (query) applied.push(`name contains "${query}"`);
    if (minSize !== undefined) applied.push(`size >= ${this.formatBytes(minSize)}`);
    if (maxSize !== undefined) applied.push(`size <= ${this.formatBytes(maxSize)}`);
    if (after) applied.push(`modified >= ${after.toISOString()}`);
    if (before) applied.push(`modified <= ${before.toISOString()}`);
    return this.text(this.formatPage('entries', page, this.describeFilter(filter, applied), (r) => this.formatRecord(r), 'search_files'));
  }

  private async handleSearchBySize(args: any) {
    const { driveLetter } = args;
    const filter = parseFilter(args);
    const minSize = parseSize('minSize', args.minSize);
    const maxSize = parseSize('maxSize', args.maxSize);
    if (minSize !== undefined && maxSize !== undefined && minSize > maxSize) {
      throw new Error(`minSize (${this.formatBytes(minSize)}) is larger than maxSize (${this.formatBytes(maxSize)}).`);
    }
    const page = this.getIndexedIndexer(driveLetter).searchBySize(minSize, maxSize, filter);
    const applied: string[] = [];
    if (minSize !== undefined) applied.push(`size >= ${this.formatBytes(minSize)}`);
    if (maxSize !== undefined) applied.push(`size <= ${this.formatBytes(maxSize)}`);
    return this.text(this.formatPage('files', page, this.describeFilter(filter, applied), (r) => this.formatRecord(r), 'search_by_size'));
  }

  private async handleSearchByDate(args: any) {
    const { driveLetter } = args;
    const filter = parseFilter(args);
    const after = parseDate('after', args.after);
    const before = parseDate('before', args.before, true);
    if (after && before && after > before) throw new Error('"after" is later than "before".');
    const page = this.getIndexedIndexer(driveLetter).searchByDate(after, before, filter);
    const applied: string[] = [];
    if (after) applied.push(`modified >= ${after.toISOString()}`);
    if (before) applied.push(`modified <= ${before.toISOString()}`);
    return this.text(this.formatPage('entries', page, this.describeFilter(filter, applied), (r) => this.formatRecord(r), 'search_by_date'));
  }

  private async handleGetLargestFiles(args: any) {
    const filter = parseFilter(args);
    const page = this.getIndexedIndexer(args.driveLetter).getLargestFiles(filter);
    return this.text(this.formatPage('files', page, this.describeFilter(filter), (r) => this.formatRecord(r), 'get_largest_files'));
  }

  private async handleGetLargestDirectories(args: any) {
    const filter = { ...parseFilter(args), types: undefined };
    const page = this.getIndexedIndexer(args.driveLetter).getLargestDirectories(filter);
    return this.text(
      this.formatPage(
        'directories',
        page,
        this.describeFilter(filter, ['recursive sizes']),
        (d) => `${d.path} - ${this.formatBytes(d.size)} - ${d.fileCount.toLocaleString()} files`,
        'get_largest_directories'
      )
    );
  }

  private handleListFileTypes() {
    const lines = Object.entries(FILE_TYPE_CATEGORIES).map(([name, exts]) => `${name}: ${exts.map((e) => '.' + e).join(' ')}`);
    return this.text(
      `File type presets for the "types" filter (aliases such as "videos", "movies", "pictures", "docs" also work):\n\n` +
        lines.join('\n') +
        `\n\n"${FOLDER_TYPE}": directories only\n\nAny other format: pass its extension, e.g. "mkv", ".psd", "*.xyz". ` +
        `Presets and extensions can be mixed: ["video", "iso", ".xyz"].`
    );
  }

  private async handleGetDiskUsage(args: any) {
    const { driveLetter } = args;
    const usage = this.diskReporter.getDiskUsage(driveLetter);
    const indexer = this.getOrCreateIndexer(driveLetter);
    const stats = indexer.hasIndex() ? indexer.getStats() : null;

    let out =
      `Disk Usage for ${usage.driveLetter}:\n\n` +
      `Total Space: ${this.formatBytes(usage.totalSpace)}\n` +
      `Used Space: ${this.formatBytes(usage.usedSpace)} (${usage.usagePercent.toFixed(1)}%)\n` +
      `Free Space: ${this.formatBytes(usage.freeSpace)}\n`;

    if (stats) {
      out +=
        `Files: ${stats.totalFiles.toLocaleString()}\n` +
        `Directories: ${stats.totalDirectories.toLocaleString()}\n\n` +
        `Largest Files:\n` +
        indexer.getLargestFiles().items.slice(0, 10).map((f, i) => `${i + 1}. ${f.fullPath} - ${this.formatBytes(f.realSize)}`).join('\n') + '\n\n' +
        `Largest Directories:\n` +
        indexer.getLargestDirectories().items.slice(0, 10).map((d, i) => `${i + 1}. ${d.path} - ${this.formatBytes(d.size)} (${d.fileCount.toLocaleString()} files)`).join('\n');
    } else {
      out += `\n(Drive not indexed yet - run index_drive to also get file counts and the largest files/directories.)`;
    }
    return this.text(out);
  }

  private async handleGetIndexStats(args: any) {
    const { driveLetter } = args;
    const stats = this.getIndexedIndexer(driveLetter).getStats()!;
    return this.text(
      `Index Statistics for ${stats.driveLetter}:\n\n` +
        (stats.scope
          ? `Scope: ${stats.scope.mode} ${stats.scope.entries.map((e) => `"${e}"`).join(', ')} ` +
            `(this index does not cover the whole drive)\n`
          : '') +
        `Total Files: ${stats.totalFiles.toLocaleString()}\n` +
        `Total Directories: ${stats.totalDirectories.toLocaleString()}\n` +
        `Total Size: ${this.formatBytes(stats.totalSize)}\n` +
        `Indexed At: ${stats.indexedAt.toISOString()}\n` +
        `Duration: ${stats.duration}ms`
    );
  }

  private async handleListDrives() {
    const drives = this.diskReporter.getDrives();
    
    return {
      content: [{
        type: 'text',
        text: `Available Drives:\n\n` +
              drives.map(d => `${d.letter}: - ${d.type} - ${this.formatBytes(d.totalSpace)} total, ${this.formatBytes(d.freeSpace)} free`).join('\n'),
      }],
    };
  }

  private formatBytes(bytes: bigint): string {
    const num = Number(bytes);
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
    if (num < 1024 * 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    return `${(num / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
  }

  /** Start serving. Defaults to stdio (what MCP hosts use); tests pass an in-memory transport. */
  async start(transport: Transport = new StdioServerTransport()): Promise<void> {
    await this.server.connect(transport);
    console.error('MFT Indexer MCP Server started');
  }

  async stop(): Promise<void> {
    for (const indexer of this.indexers.values()) {
      indexer.close();
    }
    await this.server.close();
  }
}

export function createMCPServer(): MFTMCPServer {
  return new MFTMCPServer();
}

if (require.main === module) {
  const server = createMCPServer();
  const shutdown = () => {
    server.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.start().catch((error) => {
    console.error('Failed to start MFT Indexer MCP server:', error);
    process.exit(1);
  });
}