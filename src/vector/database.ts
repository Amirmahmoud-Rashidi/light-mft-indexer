// Vector Database - For semantic file search using embeddings
import Database from 'better-sqlite3';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface VectorConfig {
  dimensions: number;
  indexPath: string;
  modelName?: string;
}

export interface FileEmbedding {
  recordNumber: number;
  fileName: string;
  fullPath: string;
  embedding: Float32Array;
  metadata: Record<string, any>;
}

export interface SearchResult {
  recordNumber: number;
  fileName: string;
  fullPath: string;
  score: number;
  metadata: Record<string, any>;
}

export class VectorDatabase extends EventEmitter {
  private db: Database.Database;
  private config: VectorConfig;
  private dimensions: number;

  constructor(config: VectorConfig) {
    super();
    this.config = config;
    this.dimensions = config.dimensions;
    this.db = new Database(config.indexPath);
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        record_number INTEGER PRIMARY KEY,
        file_name TEXT NOT NULL,
        full_path TEXT NOT NULL,
        embedding BLOB NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_embeddings_path ON embeddings(full_path);
      CREATE INDEX IF NOT EXISTS idx_embeddings_name ON embeddings(file_name);
    `);
  }

  // Simple hash-based embedding for file names and paths (no external model needed)
  private generateEmbedding(text: string): Float32Array {
    const embedding = new Float32Array(this.dimensions);
    let hash = 0;
    
    // Generate hash from text
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    
    // Use hash to seed pseudo-random values
    let seed = Math.abs(hash);
    for (let i = 0; i < this.dimensions; i++) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      embedding[i] = (seed / 4294967296) * 2 - 1; // Normalize to [-1, 1]
    }
    
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        embedding[i] /= norm;
      }
    }
    
    return embedding;
  }

  // Cosine similarity between two vectors
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < this.dimensions; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async addFile(recordNumber: number, fileName: string, fullPath: string, metadata: Record<string, any> = {}): Promise<void> {
    const text = `${fileName} ${fullPath}`.toLowerCase();
    const embedding = this.generateEmbedding(text);
    
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings 
      (record_number, file_name, full_path, embedding, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    `);
    
    insert.run(
      recordNumber,
      fileName,
      fullPath,
      Buffer.from(embedding.buffer),
      JSON.stringify(metadata)
    );
    
    this.emit('added', { recordNumber, fileName });
  }

  async addBatch(files: Array<{ recordNumber: number; fileName: string; fullPath: string; metadata?: Record<string, any> }>): Promise<void> {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings 
      (record_number, file_name, full_path, embedding, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    `);
    
    const transaction = this.db.transaction((batch) => {
      for (const file of batch) {
        const text = `${file.fileName} ${file.fullPath}`.toLowerCase();
        const embedding = this.generateEmbedding(text);
        
        insert.run(
          file.recordNumber,
          file.fileName,
          file.fullPath,
          Buffer.from(embedding.buffer),
          JSON.stringify(file.metadata || {})
        );
      }
    });
    
    transaction(files);
    this.emit('batchAdded', { count: files.length });
  }

  async search(query: string, limit: number = 10, threshold: number = 0.3): Promise<SearchResult[]> {
    const queryEmbedding = this.generateEmbedding(query.toLowerCase());
    
    const stmt = this.db.prepare(`
      SELECT record_number, file_name, full_path, embedding, metadata
      FROM embeddings
    `);
    
    const rows = stmt.all() as any[];
    const results: SearchResult[] = [];
    
    for (const row of rows) {
      const embedding = new Float32Array(row.embedding.buffer);
      const score = this.cosineSimilarity(queryEmbedding, embedding);
      
      if (score >= threshold) {
        results.push({
          recordNumber: row.record_number,
          fileName: row.file_name,
          fullPath: row.full_path,
          score,
          metadata: JSON.parse(row.metadata || '{}'),
        });
      }
    }
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    return results.slice(0, limit);
  }

  async searchByPath(pathPrefix: string, limit: number = 10): Promise<SearchResult[]> {
    const stmt = this.db.prepare(`
      SELECT record_number, file_name, full_path, embedding, metadata
      FROM embeddings
      WHERE full_path LIKE ?
      ORDER BY full_path
      LIMIT ?
    `);
    
    const rows = stmt.all(`${pathPrefix}%`, limit) as any[];
    
    return rows.map(row => ({
      recordNumber: row.record_number,
      fileName: row.file_name,
      fullPath: row.full_path,
      score: 1.0,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  async getByRecordNumber(recordNumber: number): Promise<FileEmbedding | null> {
    const stmt = this.db.prepare(`
      SELECT record_number, file_name, full_path, embedding, metadata
      FROM embeddings
      WHERE record_number = ?
    `);
    
    const row = stmt.get(recordNumber) as any;
    if (!row) return null;
    
    return {
      recordNumber: row.record_number,
      fileName: row.file_name,
      fullPath: row.full_path,
      embedding: new Float32Array(row.embedding.buffer),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  async deleteFile(recordNumber: number): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM embeddings WHERE record_number = ?');
    stmt.run(recordNumber);
    this.emit('deleted', { recordNumber });
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM embeddings');
    this.emit('cleared');
  }

  getStats(): { count: number; dimensions: number; dbSize: number } {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
    const dbSize = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count, pragma_page_size').get() as { size: number };
    
    return {
      count: count.count,
      dimensions: this.dimensions,
      dbSize: dbSize.size,
    };
  }

  close(): void {
    this.db.close();
  }
}

export function createVectorDatabase(config: VectorConfig): VectorDatabase {
  return new VectorDatabase(config);
}