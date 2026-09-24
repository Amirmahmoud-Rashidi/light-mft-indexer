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
import { IndexOptions, MFTRecord } from '../mft/types';
import { DiskReporter, createDiskReporter } from '../reporter';

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
          description: 'Index an NTFS drive by reading its MFT (needs Administrator rights; can take from seconds to a few minutes). Must be run once before any search on that drive.',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string', description: 'Drive letter (e.g., "C")' },
              includeHidden: { type: 'boolean', default: false },
              includeSystem: { type: 'boolean', default: false },
              batchSize: { type: 'number', default: 1000 },
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'search_files',
          description: 'Search for files by name or path',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string', description: 'Drive letter' },
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'number', default: 100 },
            },
            required: ['driveLetter', 'query'],
          },
        },
        {
          name: 'search_by_size',
          description: 'Search files by size range',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
              minSize: { type: 'string', description: 'Minimum size in bytes' },
              maxSize: { type: 'string', description: 'Maximum size in bytes' },
              limit: { type: 'number', default: 100 },
            },
            required: ['driveLetter', 'minSize', 'maxSize'],
          },
        },
        {
          name: 'search_by_date',
          description: 'Search files by modification date range',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
              after: { type: 'string', description: 'ISO date string' },
              before: { type: 'string', description: 'ISO date string' },
              limit: { type: 'number', default: 100 },
            },
            required: ['driveLetter', 'after', 'before'],
          },
        },
        {
          name: 'get_largest_files',
          description: 'Get largest files on a drive',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
              limit: { type: 'number', default: 50 },
            },
            required: ['driveLetter'],
          },
        },
        {
          name: 'get_largest_directories',
          description: 'Get largest directories on a drive',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
              limit: { type: 'number', default: 50 },
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
            text: JSON.stringify(drives, null, 2),
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
    const kind = (r.flags & 0x02) !== 0 ? '[DIR] ' : '';
    const size = (r.flags & 0x02) !== 0 ? '' : ` (${this.formatBytes(r.realSize)})`;
    return `${kind}${r.fullPath ?? r.fileName}${size} - modified ${r.modificationTime.toISOString()}`;
  }

  private async handleIndexDrive(args: any) {
    const { driveLetter, includeHidden, includeSystem, batchSize } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const stats = await indexer.index({ includeHidden, includeSystem, batchSize });

    return this.text(
      `Indexing complete for ${stats.driveLetter}:\n` +
        `Files: ${stats.totalFiles.toLocaleString()}\n` +
        `Directories: ${stats.totalDirectories.toLocaleString()}\n` +
        `Total Size: ${this.formatBytes(stats.totalSize)}\n` +
        `Duration: ${stats.duration}ms\n` +
        `Indexed at: ${stats.indexedAt.toISOString()}`
    );
  }

  private async handleSearchFiles(args: any) {
    const { driveLetter, query, limit } = args;
    const results = this.getIndexedIndexer(driveLetter).search(String(query), limit);
    return this.text(`Found ${results.length} entries matching "${query}":\n\n` + results.map((r) => this.formatRecord(r)).join('\n'));
  }

  private async handleSearchBySize(args: any) {
    const { driveLetter, minSize, maxSize, limit } = args;
    const results = this.getIndexedIndexer(driveLetter).searchBySize(BigInt(minSize), BigInt(maxSize), limit);
    return this.text(
      `Found ${results.length} files between ${this.formatBytes(BigInt(minSize))} and ${this.formatBytes(BigInt(maxSize))}:\n\n` +
        results.map((r) => this.formatRecord(r)).join('\n')
    );
  }

  private async handleSearchByDate(args: any) {
    const { driveLetter, after, before, limit } = args;
    const results = this.getIndexedIndexer(driveLetter).searchByDate(new Date(after), new Date(before), limit);
    return this.text(
      `Found ${results.length} entries modified between ${after} and ${before}:\n\n` +
        results.map((r) => this.formatRecord(r)).join('\n')
    );
  }

  private async handleGetLargestFiles(args: any) {
    const { driveLetter, limit } = args;
    const results = this.getIndexedIndexer(driveLetter).getLargestFiles(limit);
    return this.text(
      `Top ${results.length} largest files on ${normalizeDriveLetter(driveLetter)}:\n\n` +
        results.map((r, i) => `${i + 1}. ${r.fullPath} - ${this.formatBytes(r.realSize)} - ${r.modificationTime.toISOString()}`).join('\n')
    );
  }

  private async handleGetLargestDirectories(args: any) {
    const { driveLetter, limit } = args;
    const results = this.getIndexedIndexer(driveLetter).getLargestDirectories(limit);
    return this.text(
      `Top ${results.length} largest directories on ${normalizeDriveLetter(driveLetter)} (recursive size):\n\n` +
        results.map((r, i) => `${i + 1}. ${r.path} - ${this.formatBytes(r.size)} - ${r.fileCount.toLocaleString()} files`).join('\n')
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
        indexer.getLargestFiles(10).map((f, i) => `${i + 1}. ${f.fullPath} - ${this.formatBytes(f.realSize)}`).join('\n') + '\n\n' +
        `Largest Directories:\n` +
        indexer.getLargestDirectories(10).map((d, i) => `${i + 1}. ${d.path} - ${this.formatBytes(d.size)} (${d.fileCount.toLocaleString()} files)`).join('\n');
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
