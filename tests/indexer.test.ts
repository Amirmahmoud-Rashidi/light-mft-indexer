import { MFTIndexer } from '../src/mft/indexer';
import { IndexOptions } from '../src/mft/types';
import { LONG_NAME, makeFakeVolume } from './fake-volume';

// Most fixtures below assume hidden/system files are excluded; the defaults are tested separately.
const EXCLUDE: IndexOptions = { includeHidden: false, includeSystem: false };

function makeIndexer(options: IndexOptions = EXCLUDE) {
  const fake = makeFakeVolume();
  const indexer = new MFTIndexer('c', options, { openParser: () => fake.parser(), dbPath: ':memory:' });
  return { ...fake, indexer };
}
const paths = (rs: { fullPath?: string }[]) => rs.map((r) => r.fullPath).sort();

describe('MFTIndexer (synthetic volume, real SQLite)', () => {
  it('has no index until index() has run', () => {
    const { indexer } = makeIndexer();
    expect(indexer.hasIndex()).toBe(false);
    expect(indexer.getStats()).toBeNull();
  });

  it('indexes hidden and system files by default (hiberfil.sys, pagefile.sys, $MFT, ...)', async () => {
    const { indexer } = makeIndexer({});
    const stats = await indexer.index();
    expect(stats.totalFiles).toBe(9); // + hidden.dat (hidden) and $MFT (hidden+system)
    expect(stats.totalSize).toBe(5_000_132n + 7n + 81_920n);
    expect(paths(indexer.search('hidden.dat').items)).toEqual(['C:\\Users\\hidden.dat']);
    expect(paths(indexer.search('$MFT').items)).toEqual(['C:\\$MFT']);
  });

  it('can exclude hidden and/or system files on request', async () => {
    const onlySystemOut = makeIndexer({ includeSystem: false });
    expect((await onlySystemOut.indexer.index()).totalFiles).toBe(8); // $MFT (system) gone, hidden.dat stays
    const onlyHiddenOut = makeIndexer({ includeHidden: false });
    expect((await onlyHiddenOut.indexer.index()).totalFiles).toBe(7); // $MFT is hidden too, so both gone
  });

  it('indexes with correct counts and sizes (hidden/system files excluded when asked)', async () => {
    const { indexer, mem } = makeIndexer();
    const stats = await indexer.index();
    expect(stats.driveLetter).toBe('C');
    expect(stats.totalDirectories).toBe(4); // root, Users, Docs, Lost
    expect(stats.totalFiles).toBe(7);
    // 11 + 5,000,000 (size comes from the EXTENSION record) + 100 + 5 + 3 + 4 + 9
    expect(stats.totalSize).toBe(5_000_132n);
    expect(mem.closed).toBe(true); // volume is released after indexing
    expect(indexer.hasIndex()).toBe(true);
    expect(indexer.getStats()!.totalFiles).toBe(7); // persisted, survives a new process
  });

  it('includes hidden and system files on request', async () => {
    const { indexer } = makeIndexer();
    const stats = await indexer.index({ includeHidden: true, includeSystem: true });
    expect(stats.totalFiles).toBe(9); // + hidden.dat and $MFT
    expect(stats.totalSize).toBe(5_000_132n + 7n + 81_920n);
  });

  it('builds correct full paths, including out-of-order parents and orphans', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    expect(paths(indexer.search('readme').items)).toEqual(['C:\\Users\\readme.txt']);
    expect(paths(indexer.search('a.txt').items)).toEqual(['C:\\Users\\Docs\\a.txt']);
    expect(paths(indexer.search('big.bin').items)).toEqual(['C:\\Users\\big.bin']);
    expect(paths(indexer.search('inlost').items)).toEqual(['C:\\<unknown>\\Lost\\inlost.txt']);
    expect(paths(indexer.search('orphan').items)).toEqual(['?\\orphan.txt']);
    expect(paths(indexer.search('Docs').items)).toEqual(['C:\\Users\\Docs']);
  });

  it('uses the long name and keeps names that crossed a fixup boundary', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    expect(paths(indexer.search('long file').items)).toEqual(['C:\\Users\\long file name.txt']);
    expect(indexer.search('LONGFI~1').items).toHaveLength(0); // DOS alias is not indexed
    expect(paths(indexer.search(LONG_NAME).items)).toEqual([`C:\\Users\\Docs\\${LONG_NAME}.txt`]);
  });

  it('skips free, torn and garbage records', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    for (const q of ['deleted', 'torn']) expect(indexer.search(q).items).toHaveLength(0);
  });

  it('searches by path when the query contains a separator, case-insensitively', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    expect(paths(indexer.search('users\\docs').items)).toEqual(['C:\\Users\\Docs', `C:\\Users\\Docs\\${LONG_NAME}.txt`, 'C:\\Users\\Docs\\a.txt'].sort());
    expect(paths(indexer.search('Users/Docs/a.t').items)).toEqual(['C:\\Users\\Docs\\a.txt']); // forward slashes accepted
  });

  it('treats LIKE wildcards in the query literally', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    expect(indexer.search('%').items).toHaveLength(0);
    expect(indexer.search('_').items).toHaveLength(0);
    expect(indexer.search("x'; DROP TABLE files; --").items).toHaveLength(0);
    expect(indexer.search('readme').items).toHaveLength(1); // table still there
  });

  it('ranks an exact name match first', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    expect(indexer.search('a.txt').items[0].fileName).toBe('a.txt');
  });

  it('computes recursive directory sizes', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    const dirs = indexer.getLargestDirectories().items;
    expect(dirs.map((d) => d.path)).toEqual(['C:\\Users', 'C:\\Users\\Docs', 'C:\\<unknown>\\Lost']);
    expect(dirs[0].size).toBe(5_000_119n); // readme + big + Docs(a.txt + long) + DOS file
    expect(dirs[0].fileCount).toBe(5);
    expect(dirs[1].size).toBe(105n);
    expect(dirs[1].fileCount).toBe(2);
    expect(dirs[2].size).toBe(9n);
  });

  it('answers size/date/largest queries with bigint sizes and Date times', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    const largest = indexer.getLargestFiles().items;
    expect(largest[0].fullPath).toBe('C:\\Users\\big.bin');
    expect(largest[0].realSize).toBe(5_000_000n);
    expect(largest[0].allocatedSize).toBe(5_001_216n);
    expect(paths(indexer.searchBySize(50n, 200n).items)).toEqual(['C:\\Users\\Docs\\a.txt']);
    const byDate = indexer.searchByDate(new Date('2024-02-01'), new Date('2024-02-28')).items;
    expect(byDate.length).toBeGreaterThan(0);
    expect(byDate[0].modificationTime.toISOString()).toBe('2024-02-03T04:05:06.000Z');
  });

  it('replaces the old index on re-index instead of accumulating', async () => {
    const { indexer } = makeIndexer();
    await indexer.index();
    await indexer.index();
    expect(indexer.search('readme').items).toHaveLength(1);
    expect(indexer.getStats()!.totalFiles).toBe(7);
  });

  it('emits start/progress/complete events', async () => {
    const { indexer } = makeIndexer({ ...EXCLUDE, batchSize: 3 });
    const events: string[] = [];
    indexer.on('start', () => events.push('start'));
    indexer.on('progress', () => events.push('progress'));
    indexer.on('complete', () => events.push('complete'));
    await indexer.index();
    expect(events[0]).toBe('start');
    expect(events.filter((e) => e === 'progress').length).toBeGreaterThan(1);
    expect(events[events.length - 1]).toBe('complete');
  });

  it('rejects concurrent indexing and releases the volume when the scan fails', async () => {
    const fake = makeFakeVolume();
    const failing = { scan: function* () { yield* []; throw new Error('read error'); }, close: () => fake.mem.close() };
    const indexer = new MFTIndexer('C', {}, { openParser: () => failing, dbPath: ':memory:' });
    await expect(indexer.index()).rejects.toThrow('read error');
    expect(fake.mem.closed).toBe(true);
    // and a later run is allowed (isIndexing was reset)
    const ok = new MFTIndexer('C', {}, { openParser: () => fake.parser(), dbPath: ':memory:' });
    const first = ok.index();
    await expect(ok.index()).rejects.toThrow('already in progress');
    await first;
  });

  it('never gets stuck reporting "already in progress" after ANY index() failure, including openParser() itself throwing', async () => {
    // Regression test: openParser() throwing (e.g. "not Windows", "access denied", or - after the
    // --only/--exclude feature - an invalid scope) must not leave isIndexing permanently true.
    const indexer = new MFTIndexer('C', {}, {
      openParser: () => { throw new Error('simulated: cannot open volume'); },
      dbPath: ':memory:',
    });
    await expect(indexer.index()).rejects.toThrow('simulated: cannot open volume');
    // if isIndexing were stuck, this would reject with "already in progress" instead of the real error
    await expect(indexer.index()).rejects.toThrow('simulated: cannot open volume');
  });

  it('an invalid --only/--exclude combination is rejected before isIndexing is set, so it never blocks a later call either', async () => {
    const fake = makeFakeVolume();
    const indexer = new MFTIndexer('C', {}, { openParser: () => fake.parser(), dbPath: ':memory:' });
    await expect(indexer.index({ only: ['C:\\a'], exclude: ['C:\\b'] })).rejects.toThrow(/either "only" or "exclude"/);
    // a valid call right after must succeed, not report "already in progress"
    const stats = await indexer.index();
    expect(stats.totalFiles).toBeGreaterThan(0);
  });

  it('validates the drive letter', () => {
    expect(() => new MFTIndexer('C:\\..\\x', {}, { dbPath: ':memory:' })).toThrow(/Invalid drive letter/);
  });
});