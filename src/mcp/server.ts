// MCP Server - Model Context Protocol server for file operations
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MFTIndexer, createIndexer } from '../mft';
import { VectorDatabase, createVectorDatabase } from '../vector';
import { DiskReporter, createDiskReporter } from '../reporter';
import { IndexOptions, SearchQuery, DiskUsage } from '../mft/types';
import * as path from 'path';

export class MFTMCPServer {
  private server: Server;
  private indexers: Map<string, MFTIndexer> = new Map();
  private vectorDbs: Map<string, VectorDatabase> = new Map();
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
          description: 'Index a drive using MFT for fast file discovery',
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
          name: 'semantic_search',
          description: 'Semantic search using vector embeddings',
          inputSchema: {
            type: 'object',
            properties: {
              driveLetter: { type: 'string' },
              query: { type: 'string' },
              limit: { type: 'number', default: 10 },
              threshold: { type: 'number', default: 0.3 },
            },
            required: ['driveLetter', 'query'],
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
          case 'semantic_search':
            return await this.handleSemanticSearch(args);
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
    const key = driveLetter.toUpperCase();
    if (!this.indexers.has(key)) {
      this.indexers.set(key, createIndexer(key, options));
    }
    return this.indexers.get(key)!;
  }

  private getOrCreateVectorDb(driveLetter: string): VectorDatabase {
    const key = driveLetter.toUpperCase();
    if (!this.vectorDbs.has(key)) {
      const dbPath = path.join(process.cwd(), `.mft-vector-${key}.db`);
      this.vectorDbs.set(key, createVectorDatabase({
        dimensions: 384,
        indexPath: dbPath,
      }));
    }
    return this.vectorDbs.get(key)!;
  }

  private async handleIndexDrive(args: any) {
    const { driveLetter, includeHidden, includeSystem, batchSize } = args;
    const indexer = this.getOrCreateIndexer(driveLetter, { includeHidden, includeSystem, batchSize });
    
    const stats = await indexer.index();
    
    // Also populate vector database
    const vectorDb = this.getOrCreateVectorDb(driveLetter);
    // Note: In a real implementation, you'd iterate through indexed files and add to vector DB
    
    return {
      content: [{
        type: 'text',
        text: `Indexing complete for ${driveLetter}:\n` +
              `Files: ${stats.totalFiles.toLocaleString()}\n` +
              `Directories: ${stats.totalDirectories.toLocaleString()}\n` +
              `Total Size: ${this.formatBytes(stats.totalSize)}\n` +
              `Duration: ${stats.duration}ms\n` +
              `Indexed at: ${stats.indexedAt.toISOString()}`,
      }],
    };
  }

  private async handleSearchFiles(args: any) {
    const { driveLetter, query, limit } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const results = indexer.search(query, limit);
    
    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} files matching "${query}":\n\n` +
              results.map(r => `${r.fileName} (${this.formatBytes(r.realSize)}) - ${r.modificationTime.toISOString()}`).join('\n'),
      }],
    };
  }

  private async handleSearchBySize(args: any) {
    const { driveLetter, minSize, maxSize, limit } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const results = indexer.searchBySize(BigInt(minSize), BigInt(maxSize), limit);
    
    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} files between ${this.formatBytes(BigInt(minSize))} and ${this.formatBytes(BigInt(maxSize))}:\n\n` +
              results.map(r => `${r.fileName} (${this.formatBytes(r.realSize)}) - ${r.modificationTime.toISOString()}`).join('\n'),
      }],
    };
  }

  private async handleSearchByDate(args: any) {
    const { driveLetter, after, before, limit } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const results = indexer.searchByDate(new Date(after), new Date(before), limit);
    
    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} files modified between ${after} and ${before}:\n\n` +
              results.map(r => `${r.fileName} (${this.formatBytes(r.realSize)}) - ${r.modificationTime.toISOString()}`).join('\n'),
      }],
    };
  }

  private async handleGetLargestFiles(args: any) {
    const { driveLetter, limit } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const results = indexer.getLargestFiles(limit);
    
    return {
      content: [{
        type: 'text',
        text: `Top ${results.length} largest files on ${driveLetter}:\n\n` +
              results.map((r, i) => `${i + 1}. ${r.fileName} - ${this.formatBytes(r.realSize)} - ${r.modificationTime.toISOString()}`).join('\n'),
      }],
    };
  }

  private async handleGetLargestDirectories(args: any) {
    const { driveLetter, limit } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const results = indexer.getLargestDirectories(limit);
    
    return {
      content: [{
        type: 'text',
        text: `Top ${results.length} largest directories on ${driveLetter}:\n\n` +
              results.map((r, i) => `${i + 1}. Record ${r.record_number} - ${this.formatBytes(BigInt(r.total_size))} - ${r.file_count} files`).join('\n'),
      }],
    };
  }

  private async handleGetDiskUsage(args: any) {
    const { driveLetter } = args;
    const usage = this.diskReporter.getDiskUsage(driveLetter);
    
    return {
      content: [{
        type: 'text',
        text: `Disk Usage for ${driveLetter}:\n\n` +
              `Total Space: ${this.formatBytes(usage.totalSpace)}\n` +
              `Used Space: ${this.formatBytes(usage.usedSpace)} (${usage.usagePercent.toFixed(1)}%)\n` +
              `Free Space: ${this.formatBytes(usage.freeSpace)}\n` +
              `Files: ${usage.fileCount.toLocaleString()}\n` +
              `Directories: ${usage.directoryCount.toLocaleString()}\n\n` +
              `Largest Files:\n` +
              usage.largestFiles.slice(0, 10).map((f, i) => `${i + 1}. ${f.path} - ${this.formatBytes(f.size)}`).join('\n') + '\n\n' +
              `Largest Directories:\n` +
              usage.largestDirectories.slice(0, 10).map((d, i) => `${i + 1}. ${d.path} - ${this.formatBytes(d.size)} (${d.fileCount} files)`).join('\n'),
      }],
    };
  }

  private async handleGetIndexStats(args: any) {
    const { driveLetter } = args;
    const indexer = this.getOrCreateIndexer(driveLetter);
    const stats = indexer.getStats();
    
    return {
      content: [{
        type: 'text',
        text: `Index Statistics for ${driveLetter}:\n\n` +
              `Total Files: ${stats.totalFiles.toLocaleString()}\n` +
              `Total Directories: ${stats.totalDirectories.toLocaleString()}\n` +
              `Total Size: ${this.formatBytes(stats.totalSize)}\n` +
              `Indexed At: ${stats.indexedAt.toISOString()}\n` +
              `Duration: ${stats.duration}ms`,
      }],
    };
  }

  private async handleSemanticSearch(args: any) {
    const { driveLetter, query, limit, threshold } = args;
    const vectorDb = this.getOrCreateVectorDb(driveLetter);
    const results = await vectorDb.search(query, limit, threshold);
    
    return {
      content: [{
        type: 'text',
        text: `Semantic search results for "${query}" (threshold: ${threshold}):\n\n` +
              results.map((r, i) => `${i + 1}. ${r.fileName} (${(r.score * 100).toFixed(1)}%) - ${r.fullPath}`).join('\n'),
      }],
    };
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

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MFT Indexer MCP Server started');
  }

  async stop(): Promise<void> {
    for (const indexer of this.indexers.values()) {
      indexer.close();
    }
    for (const vectorDb of this.vectorDbs.values()) {
      vectorDb.close();
    }
    await this.server.close();
  }
}

export function createMCPServer(): MFTMCPServer {
  return new MFTMCPServer();
}