// MFT Indexer - High-performance file system indexer using MFT
import { MFTParser, createMFTParser } from './parser';
import { MFTRecord, IndexOptions, IndexStats, FileAttributes, MFTRecordFlags } from './types';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as path from 'path';

export class MFTIndexer extends EventEmitter {
  private parser: MFTParser;
  private db: Database.Database;
  private options: IndexOptions;
  private stats: IndexStats;
  private isIndexing = false;
  private batchBuffer: MFTRecord[] = [];
  private batchSize: number;

  constructor(driveLetter: string, options: IndexOptions = {}) {
    super();
    this.parser = createMFTParser(driveLetter);
    this.options = {
      includeHidden: false,
      includeSystem: false,
      maxDepth: -1,
      followJunctions: false,
      batchSize: 1000,
      ...options,
    };
    this.batchSize = this.options.batchSize || 1000;
    
    // Initialize SQLite database
    const dbPath = path.join(process.cwd(), `.mft-index-${driveLetter}.db`);
    this.db = new Database(dbPath);
    this.initDatabase();
    
    this.stats = {
      totalFiles: 0,
      totalDirectories: 0,
      totalSize: 0n,
      indexedAt: new Date(),
      duration: 0,
      driveLetter,
    };
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        record_number INTEGER PRIMARY KEY,
        sequence_number INTEGER,
        parent_record_number INTEGER,
        file_name TEXT NOT NULL,
        full_path TEXT,
        creation_time INTEGER,
        modification_time INTEGER,
        access_time INTEGER,
        mft_modification_time INTEGER,
        allocated_size INTEGER,
        real_size INTEGER,
        file_attributes INTEGER,
        flags INTEGER,
        is_directory INTEGER,
        indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_parent ON files(parent_record_number);
      CREATE INDEX IF NOT EXISTS idx_name ON files(file_name);
      CREATE INDEX IF NOT EXISTS idx_path ON files(full_path);
      CREATE INDEX IF NOT EXISTS idx_size ON files(real_size);
      CREATE INDEX IF NOT EXISTS idx_modified ON files(modification_time);
      CREATE INDEX IF NOT EXISTS idx_attr ON files(file_attributes);
    `);
  }

  async index(): Promise<IndexStats> {
    if (this.isIndexing) {
      throw new Error('Indexing already in progress');
    }

    this.isIndexing = true;
    const startTime = Date.now();
    this.stats = {
      totalFiles: 0,
      totalDirectories: 0,
      totalSize: 0n,
      indexedAt: new Date(),
      duration: 0,
      driveLetter: this.options.driveLetter,
    };

    try {
      this.emit('start', { driveLetter: this.options.driveLetter });
      
      // Build path cache for fast path resolution
      const pathCache = new Map<number, string>();
      pathCache.set(5, ''); // Root directory record number is typically 5
      
      // First pass: collect all records and build paths
      const records: MFTRecord[] = [];
      
      for (const record of this.parser.enumerateRecords()) {
        if (!this.shouldIndex(record)) continue;
        
        records.push(record);
        
        if (records.length >= this.batchSize) {
          await this.processBatch(records, pathCache);
          records.length = 0;
        }
      }
      
      // Process remaining records
      if (records.length > 0) {
        await this.processBatch(records, pathCache);
      }
      
      this.stats.duration = Date.now() - startTime;
      this.stats.indexedAt = new Date();
      
      this.emit('complete', this.stats);
      return this.stats;
    } finally {
      this.isIndexing = false;
      this.parser.close();
    }
  }

  private shouldIndex(record: MFTRecord): boolean {
    if (!this.options.includeHidden && (record.fileAttributes & FileAttributes.HIDDEN)) {
      return false;
    }
    if (!this.options.includeSystem && (record.fileAttributes & FileAttributes.SYSTEM)) {
      return false;
    }
    return true;
  }

  private async processBatch(records: MFTRecord[], pathCache: Map<number, string>): Promise<void> {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO files 
      (record_number, sequence_number, parent_record_number, file_name, full_path,
       creation_time, modification_time, access_time, mft_modification_time,
       allocated_size, real_size, file_attributes, flags, is_directory)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((batch: MFTRecord[]) => {
      for (const record of batch) {
        const isDirectory = (record.flags & MFTRecordFlags.DIRECTORY) !== 0;
        const parentPath = pathCache.get(record.parentRecordNumber) || '';
        const fullPath = parentPath ? path.join(parentPath, record.fileName) : record.fileName;
        
        pathCache.set(record.recordNumber, fullPath);
        
        insert.run(
          record.recordNumber,
          record.sequenceNumber,
          record.parentRecordNumber,
          record.fileName,
          fullPath,
          record.creationTime.getTime(),
          record.modificationTime.getTime(),
          record.accessTime.getTime(),
          record.mftModificationTime.getTime(),
          record.allocatedSize.toString(),
          record.realSize.toString(),
          record.fileAttributes,
          record.flags,
          isDirectory ? 1 : 0
        );

        if (isDirectory) {
          this.stats.totalDirectories++;
        } else {
          this.stats.totalFiles++;
          this.stats.totalSize += record.realSize;
        }
      }
    });

    transaction(records);
    this.emit('progress', { 
      files: this.stats.totalFiles, 
      directories: this.stats.totalDirectories,
      size: this.stats.totalSize.toString()
    });
  }

  search(query: string, limit: number = 100): MFTRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM files 
      WHERE file_name LIKE ? OR full_path LIKE ?
      ORDER BY 
        CASE WHEN file_name = ? THEN 0 ELSE 1 END,
        real_size DESC
      LIMIT ?
    `);
    
    const pattern = `%${query}%`;
    const rows = stmt.all(pattern, pattern, query, limit) as any[];
    
    return rows.map(row => this.rowToRecord(row));
  }

  searchBySize(minSize: bigint, maxSize: bigint, limit: number = 100): MFTRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM files 
      WHERE real_size >= ? AND real_size <= ?
      ORDER BY real_size DESC
      LIMIT ?
    `);
    
    const rows = stmt.all(minSize.toString(), maxSize.toString(), limit) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  searchByDate(after: Date, before: Date, limit: number = 100): MFTRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM files 
      WHERE modification_time >= ? AND modification_time <= ?
      ORDER BY modification_time DESC
      LIMIT ?
    `);
    
    const rows = stmt.all(after.getTime(), before.getTime(), limit) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  getLargestFiles(limit: number = 50): MFTRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM files 
      WHERE is_directory = 0
      ORDER BY real_size DESC
      LIMIT ?
    `);
    
    const rows = stmt.all(limit) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  getLargestDirectories(limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT parent_record_number as record_number, 
             SUM(real_size) as total_size,
             COUNT(*) as file_count
      FROM files 
      WHERE is_directory = 0
      GROUP BY parent_record_number
      ORDER BY total_size DESC
      LIMIT ?
    `);
    
    return stmt.all(limit);
  }

  getStats(): IndexStats {
    return { ...this.stats };
  }

  getDatabasePath(): string {
    return this.db.name;
  }

  close(): void {
    this.parser.close();
    this.db.close();
  }

  private rowToRecord(row: any): MFTRecord {
    return {
      recordNumber: row.record_number,
      sequenceNumber: row.sequence_number,
      flags: row.flags,
      linkCount: 1,
      attributeOffset: 0,
      attributes: [],
      fileName: row.file_name,
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

export function createIndexer(driveLetter: string, options?: IndexOptions): MFTIndexer {
  return new MFTIndexer(driveLetter, options);
}