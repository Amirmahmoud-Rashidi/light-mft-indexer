import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getIndexDbPath } from '../src/mft/drive';
import { MFTIndexer } from '../src/mft/indexer';
import { MFTMCPServer } from '../src/mcp/server';
import { makeFakeVolume } from './fake-volume';

const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

describe('MCP server', () => {
  let dir: string;
  let server: MFTMCPServer;
  let client: Client;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mft-mcp-'));
    process.env.MFT_INDEXER_DATA_DIR = dir;

    // Pre-build the C: index from the synthetic volume (as index_drive would on Windows).
    const fake = makeFakeVolume();
    const seed = new MFTIndexer('C', {}, { openParser: () => fake.parser(), dbPath: getIndexDbPath('C') });
    await seed.index();
    seed.close();

    server = new MFTMCPServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.start(b);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(a);
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
    delete process.env.MFT_INDEXER_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists the tools (and no longer advertises the fake semantic search)', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_disk_usage', 'get_index_stats', 'get_largest_directories', 'get_largest_files',
      'index_drive', 'list_drives', 'search_by_date', 'search_by_size', 'search_files',
    ]);
  });

  it('search_files returns full paths', async () => {
    const r: any = await client.callTool({ name: 'search_files', arguments: { driveLetter: 'c', query: 'a.txt' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('C:\\Users\\Docs\\a.txt (100 B)');
  });

  it('marks directories in results', async () => {
    const r: any = await client.callTool({ name: 'search_files', arguments: { driveLetter: 'C', query: 'Docs' } });
    expect(text(r)).toContain('[DIR] C:\\Users\\Docs');
  });

  it('search_by_size accepts bigint strings', async () => {
    const r: any = await client.callTool({ name: 'search_by_size', arguments: { driveLetter: 'C', minSize: '1000000', maxSize: '9000000000000' } });
    expect(text(r)).toContain('C:\\Users\\big.bin');
    expect(text(r)).toContain('4.8 MB');
  });

  it('largest files / directories / index stats work from the index', async () => {
    const files: any = await client.callTool({ name: 'get_largest_files', arguments: { driveLetter: 'C', limit: 1 } });
    expect(text(files)).toContain('1. C:\\Users\\big.bin');
    const dirs: any = await client.callTool({ name: 'get_largest_directories', arguments: { driveLetter: 'C', limit: 2 } });
    expect(text(dirs)).toContain('1. C:\\Users - 4.8 MB - 5 files');
    const stats: any = await client.callTool({ name: 'get_index_stats', arguments: { driveLetter: 'C' } });
    expect(text(stats)).toContain('Total Files: 7');
  });

  it('gives an actionable error for a drive that was never indexed (no admin needed)', async () => {
    const r: any = await client.callTool({ name: 'search_files', arguments: { driveLetter: 'Z', query: 'x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not been indexed.*index_drive/);
  });

  it('rejects malicious drive input before it can reach a device path or file name', async () => {
    const r: any = await client.callTool({ name: 'index_drive', arguments: { driveLetter: 'C:\\..\\..\\evil' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid drive letter/);
    expect(fs.readdirSync(dir).some((f) => f.includes('evil'))).toBe(false);
  });

  it('reports Windows-only failures as tool errors instead of crashing the server', async () => {
    if (process.platform === 'win32') return;
    const r: any = await client.callTool({ name: 'index_drive', arguments: { driveLetter: 'C' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs Windows/);
    // server is still alive
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('keeps the previous index if a re-index fails to open the volume', async () => {
    if (process.platform === 'win32') return;
    await client.callTool({ name: 'index_drive', arguments: { driveLetter: 'C' } }); // fails: not Windows
    const r: any = await client.callTool({ name: 'search_files', arguments: { driveLetter: 'C', query: 'readme' } });
    expect(text(r)).toContain('C:\\Users\\readme.txt');
  });
});
