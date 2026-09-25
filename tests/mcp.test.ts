import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getIndexDbPath } from '../src/mft/drive';
import { MFTIndexer } from '../src/mft/indexer';
import { MFTMCPServer } from '../src/mcp/server';
import { makeBigVolume } from './big-volume';
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
    const seed = new MFTIndexer('C', { includeHidden: false, includeSystem: false }, { openParser: () => fake.parser(), dbPath: getIndexDbPath('C') });
    await seed.index();
    seed.close();

    // Drive D: a generated volume with 130 files (2.6 pages) for the paging tests.
    const big = makeBigVolume(129);
    const seedD = new MFTIndexer('D', {}, { openParser: () => big.parser(), dbPath: getIndexDbPath('D') });
    await seedD.index();
    seedD.close();

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
      'index_drive', 'list_drives', 'list_file_types', 'search_by_date', 'search_by_size', 'search_files',
    ]);
  });

  it('exposes the mft://drives resource with bigint sizes serialized as strings', async () => {
    const reporter = (server as any).diskReporter;
    const spy = jest.spyOn(reporter, 'getDrives').mockReturnValue([
      { letter: 'C', type: 'Fixed', totalSpace: 500_000_000_000n, freeSpace: 120_000_000_000n, usedSpace: 380_000_000_000n },
    ]);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(['mft://drives']);
    const res: any = await client.readResource({ uri: 'mft://drives' });
    const drives = JSON.parse(res.contents[0].text);
    expect(drives).toEqual([{ letter: 'C', type: 'Fixed', totalSpace: '500000000000', freeSpace: '120000000000', usedSpace: '380000000000' }]);
    spy.mockRestore();
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

  describe('paging (drive D: 130 files)', () => {
    const call = async (name: string, args: any) => {
      const r: any = await client.callTool({ name, arguments: { driveLetter: 'D', ...args } });
      return { r, t: text(r) };
    };

    it('shows 50 per page, the total, and how to get the next page', async () => {
      const p1 = (await call('get_largest_files', {})).t;
      expect(p1).toContain('Found 130 files. Showing 1-50 (page 1 of 3).');
      expect(p1).toContain('More results: call get_largest_files again with page=2 (80 more).');
      expect(p1.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(50);

      const p2 = (await call('get_largest_files', { page: 2 })).t;
      expect(p2).toContain('Showing 51-100 (page 2 of 3)');
      expect(p2).toContain('51. ');

      const p3 = (await call('get_largest_files', { page: 3 })).t;
      expect(p3).toContain('Showing 101-130 (page 3 of 3)');
      expect(p3).toContain('(End of results.)');
      expect(p3).not.toContain('More results');

      const p4 = (await call('get_largest_files', { page: 4 })).t;
      expect(p4).toMatch(/Page 4 is past the end: there are only 3 page\(s\)/);
    });

    it('accepts page as a numeric string (some clients stringify everything)', async () => {
      expect((await call('get_largest_files', { page: '2' })).t).toContain('page 2 of 3');
    });

    it('filters by file type (preset, alias and custom extension) and echoes the filters', async () => {
      const video = (await call('search_files', { types: ['video'] })).t;
      expect(video).toContain('Found 26 entries');
      expect(video).toContain('Filters: types=video');
      const custom = (await call('search_files', { types: ['videos', '.xyz'] })).t; // 26 mp4 + 25 xyz
      expect(custom).toContain('Found 51 entries');
      expect(custom).toContain('Showing 1-50 (page 1 of 2)');
    });

    it('marks hidden/system entries and can exclude them', async () => {
      const withMft = (await call('search_files', { query: '$MFT' })).t;
      expect(withMft).toContain('Found 1 entry. Showing 1 (page 1 of 1).'); // singular, no "1-1"
      expect(withMft).toMatch(/D:\\\$MFT \(179\.0 KB\) \[hidden\] \[system\]/);
      const without = (await call('search_files', { query: '$MFT', includeSystem: false })).t;
      expect(without).toContain('No entries found');
      expect(without).toContain('system excluded');
      const noHidden = (await call('get_largest_files', { includeHidden: false, includeSystem: false })).t;
      expect(noHidden).not.toContain('[hidden]');
      expect(noHidden).not.toContain('[system]');
    });

    it('takes sizes with units and open-ended ranges', async () => {
      const t = (await call('search_by_size', { minSize: '100KB' })).t;
      expect(t).toContain('Found 28 files'); // 27 generated files >= 102,400 B + $MFT
      expect(t).toContain('size >= 100.0 KB');
      const both = (await call('search_by_size', { minSize: '10 KB', maxSize: 20000 })).t;
      expect(both).toMatch(/Found \d+ files/);
    });

    it('treats a bare "before" date as the end of that day', async () => {
      const t = (await call('search_by_date', { before: '2024-01-05' })).t;
      expect(t).toContain('Found 11 entries'); // files #0..#4 (Jan 1-5), $MFT and the 5 directories, all on Jan 1
    });

    it('get_largest_directories pages and honours hidden/system', async () => {
      const t = (await call('get_largest_directories', {})).t;
      expect(t).toContain('Found 2 directories');
      expect(t).toMatch(/1\. D:\\(Docs|Media) - /);
    });

    it('explains bad input instead of crashing', async () => {
      const cases: [any, RegExp][] = [
        [{ page: 0 }, /page must be an integer >= 1/],
        [{ minSize: 'abc' }, /Invalid minSize/],
        [{ after: 'not a date' }, /Invalid after/],
        [{ types: ['a/b'] }, /Invalid file type/],
        [{ includeHidden: 'maybe' }, /Invalid includeHidden/],
      ];
      for (const [args, message] of cases) {
        const { r, t } = await call('search_files', args);
        expect(r.isError).toBe(true);
        expect(t).toMatch(message);
      }
      const range = await call('search_by_size', { minSize: '2GB', maxSize: '1GB' });
      expect(range.r.isError).toBe(true);
      expect(range.t).toMatch(/larger than maxSize/);
    });

    it('list_file_types documents the presets and the custom-extension escape hatch', async () => {
      const r: any = await client.callTool({ name: 'list_file_types', arguments: {} });
      const t = text(r);
      expect(t).toMatch(/video: \.mp4 \.mkv/);
      expect(t).toContain('"folder": directories only');
      expect(t).toMatch(/Any other format: pass its extension/);
    });
  });
});