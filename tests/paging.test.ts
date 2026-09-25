import { MFTIndexer } from '../src/mft/indexer';
import { EntryFilter, MFTRecord, PAGE_SIZE } from '../src/mft/types';
import { Entry, makeBigVolume, visible } from './big-volume';

// 129 generated files + $MFT = 130 files  ->  pages of 50 + 50 + 30
const GENERATED = 129;
const DAY = 86400000;

async function setup() {
  const fake = makeBigVolume(GENERATED);
  const indexer = new MFTIndexer('C', {}, { openParser: () => fake.parser(), dbPath: ':memory:' });
  await indexer.index();
  return { ...fake, indexer };
}

interface AnyPage { items: MFTRecord[]; total: number; hasMore: boolean; totalPages: number; page: number }

/** Walk every page of a query, checking the paging metadata on the way. Returns every item. */
function allPages(fetch: (page: number) => AnyPage): MFTRecord[] {
  const all: MFTRecord[] = [];
  for (let page = 1; page < 1000; page++) {
    const p = fetch(page);
    expect(p.page).toBe(page);
    expect(p.items.length).toBeLessThanOrEqual(PAGE_SIZE);
    all.push(...p.items);
    if (!p.hasMore) {
      expect(all.length).toBe(p.total);
      expect(p.totalPages).toBe(Math.ceil(p.total / PAGE_SIZE));
      return all;
    }
    expect(p.items.length).toBe(PAGE_SIZE); // every page but the last is full
  }
  throw new Error('runaway paging');
}
const names = (rs: MFTRecord[]) => rs.map((r) => r.fileName);
const desc = (es: Entry[]) => [...es].sort((a, b) => b.size - a.size).map((e) => e.name);
const byDateDesc = (es: Entry[]) =>
  [...es].sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.record - b.record).map((e) => e.name);

describe('paging: nothing is truncated, 50 entries per page', () => {
  it('splits 130 files into 50 + 50 + 30 with no gaps, duplicates or reordering', async () => {
    const { indexer, entries } = await setup();
    const pages = [1, 2, 3].map((page) => indexer.getLargestFiles({ page }));
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 30]);
    expect(pages.every((p) => p.total === 130 && p.totalPages === 3 && p.pageSize === 50)).toBe(true);
    expect(pages.map((p) => [p.offset, p.hasMore])).toEqual([[0, true], [50, true], [100, false]]);

    const all = pages.flatMap((p) => p.items);
    expect(names(all)).toEqual(desc(entries)); // exactly the oracle order, across page boundaries
    expect(new Set(names(all)).size).toBe(130);
  });

  it('returns an empty slice (but the real total) for a page past the end', async () => {
    const { indexer } = await setup();
    const p = indexer.getLargestFiles({ page: 4 });
    expect(p.items).toEqual([]);
    expect(p.total).toBe(130);
    expect(p.totalPages).toBe(3);
    expect(p.hasMore).toBe(false);
  });

  it('rejects invalid page numbers with a helpful message', async () => {
    const { indexer } = await setup();
    for (const page of [0, -1, 1.5, NaN, 'abc' as any]) {
      expect(() => indexer.getLargestFiles({ page })).toThrow(/page must be an integer >= 1/);
    }
    expect(indexer.getLargestFiles({ page: '2' as any }).page).toBe(2); // numeric strings from clients are fine
  });

  it('pages every query type the same way (search, size, date, largest dirs)', async () => {
    const { indexer, entries } = await setup();
    const search = allPages((page) => indexer.search('.', { page })); // names containing a dot
    expect(new Set(names(search)).size).toBe(search.length);
    expect(search.length).toBe(GENERATED + 1); // 129 generated files + the root directory (named "."); "$MFT" has no dot

    const bySize = allPages((page) => indexer.searchBySize(50_000n, 100_000n, { page }));
    expect(names(bySize)).toEqual(desc(entries.filter((e) => e.size >= 50_000 && e.size <= 100_000)));

    const byDate = allPages((page) => indexer.searchByDate(new Date(Date.UTC(2024, 0, 1) + 10 * DAY), undefined, { page }));
    expect(byDate.length).toBeGreaterThan(50); // spans more than one page
    expect(names(byDate)).toEqual(byDateDesc(entries.filter((e) => e.mtime.getTime() >= Date.UTC(2024, 0, 11))));
  });
});

describe('paging edge: total is an exact multiple of the page size', () => {
  it('150 files -> 3 full pages, and the last full page correctly reports "no more"', async () => {
    const fake = makeBigVolume(149); // + $MFT = 150
    const indexer = new MFTIndexer('C', {}, { openParser: () => fake.parser(), dbPath: ':memory:' });
    await indexer.index();
    const pages = [1, 2, 3, 4].map((page) => indexer.getLargestFiles({ page }));
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 50, 0]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false, false]);
    expect(pages.every((p) => p.total === 150 && p.totalPages === 3)).toBe(true);
    const all = allPages((page) => indexer.getLargestFiles({ page }));
    expect(all).toHaveLength(150); // allPages() stops at the first page reporting hasMore=false
  });

  it('a single entry, and an empty result, are one/zero page(s)', async () => {
    const { indexer } = await setup();
    const one = indexer.search('$MFT');
    expect([one.total, one.totalPages, one.hasMore]).toEqual([1, 1, false]);
    const none = indexer.search('zzz-no-such-file');
    expect([none.total, none.totalPages, none.hasMore, none.items.length]).toEqual([0, 0, false, 0]);
  });
});

describe('hidden / system filters (applied when querying, not when indexing)', () => {
  const combos: [boolean, boolean][] = [[true, true], [false, true], [true, false], [false, false]];

  it.each(combos)('largest files with includeHidden=%s includeSystem=%s match the oracle', async (h, s) => {
    const { indexer, entries } = await setup();
    const expected = visible(entries, h, s);
    const got = allPages((page) => indexer.getLargestFiles({ includeHidden: h, includeSystem: s, page }));
    expect(names(got)).toEqual(desc(expected));
  });

  it('a hidden AND system file needs both flags to be true (hiberfil.sys case)', async () => {
    const { indexer } = await setup();
    const both = (h: boolean, s: boolean) => indexer.search('$MFT', { includeHidden: h, includeSystem: s }).total;
    expect([both(true, true), both(false, true), both(true, false), both(false, false)]).toEqual([1, 0, 0, 0]);
  });

  it('applies to search, size and date queries too', async () => {
    const { indexer, entries } = await setup();
    const opts: EntryFilter = { includeHidden: false, includeSystem: false };
    const plain = entries.filter((e) => !e.hidden && !e.system);
    expect(indexer.search('video', opts).total).toBe(plain.filter((e) => e.name.startsWith('video')).length);
    expect(indexer.searchBySize(undefined, undefined, opts).total).toBe(plain.length);
    expect(indexer.searchByDate(undefined, undefined, opts).items.every((r) => (r.fileAttributes & 0x6) === 0)).toBe(true);
  });

  it.each(combos)('recursive directory sizes respect includeHidden=%s includeSystem=%s', async (h, s) => {
    const { indexer, entries } = await setup();
    const shown = visible(entries, h, s);
    const dirs = allPages((page) => indexer.getLargestDirectories({ includeHidden: h, includeSystem: s, page }) as any) as any[];
    const bySize = (dir: string) => shown.filter((e) => e.dir === dir);
    const media = dirs.find((d) => d.path === 'C:\\Media');
    const docs = dirs.find((d) => d.path === 'C:\\Docs');
    expect(media.size).toBe(BigInt(bySize('Media').reduce((n, e) => n + e.size, 0)));
    expect(media.fileCount).toBe(bySize('Media').length);
    expect(docs.size).toBe(BigInt(bySize('Docs').reduce((n, e) => n + e.size, 0)));
    expect(docs.fileCount).toBe(bySize('Docs').length);
    // directories that are themselves hidden/system disappear when filtered; empty ones never show
    const paths = dirs.map((d) => d.path);
    expect(paths).not.toContain('C:\\HiddenDir');
    expect(paths).not.toContain('C:\\SystemDir');
  });

  it('largest directories are sorted by the filtered size and paged as a Page', async () => {
    const { indexer } = await setup();
    const p = indexer.getLargestDirectories();
    expect(p.total).toBe(2); // Media and Docs (root, empty and hidden/system-only dirs excluded)
    expect(p.items[0].size >= p.items[1].size).toBe(true);
  });
});

describe('file type filters', () => {
  it('preset category: video', async () => {
    const { indexer, entries } = await setup();
    const got = allPages((page) => indexer.getLargestFiles({ types: ['video'], page }));
    expect(names(got)).toEqual(desc(entries.filter((e) => e.ext === 'mp4')));
  });

  it('aliases and mixed presets + custom extensions (dot, star-dot, upper case)', async () => {
    const { indexer, entries } = await setup();
    const expected = desc(entries.filter((e) => ['mp4', 'jpg', 'xyz'].includes(e.ext)));
    for (const types of [['videos', 'pictures', '.xyz'], ['Video', 'IMAGE', '*.XYZ'], ['mp4', 'jpg', 'xyz']]) {
      expect(names(allPages((page) => indexer.getLargestFiles({ types, page })))).toEqual(expected);
    }
  });

  it('custom extension only (not in any preset)', async () => {
    const { indexer, entries } = await setup();
    const got = indexer.getLargestFiles({ types: ['.xyz'] });
    expect(got.total).toBe(entries.filter((e) => e.ext === 'xyz').length);
    expect(got.items.every((r) => r.fileName.endsWith('.xyz'))).toBe(true);
  });

  it('"folder" returns directories only, and can be mixed with extensions', async () => {
    const { indexer, entries } = await setup();
    const folders = indexer.search('', { types: ['folder'] });
    expect(folders.items.every((r) => (r.flags & 0x2) !== 0)).toBe(true);
    expect(folders.total).toBe(5); // root, Media, Docs, HiddenDir, SystemDir
    const mixed = indexer.find({ types: ['folder', 'mp4'] });
    expect(mixed.total).toBe(5 + entries.filter((e) => e.ext === 'mp4').length);
  });

  it('a type that matches nothing yields an empty result, not an error', async () => {
    const { indexer } = await setup();
    expect(indexer.getLargestFiles({ types: ['nonexistentformat'] }).total).toBe(0);
  });

  it('rejects tokens that cannot be an extension', async () => {
    const { indexer } = await setup();
    expect(() => indexer.getLargestFiles({ types: ['a/b'] })).toThrow(/Invalid file type/);
    expect(() => indexer.getLargestFiles({ types: ['x y'] })).toThrow(/Invalid file type/);
  });

  it('directories are never matched by extension (a dotted directory name is not a file type)', async () => {
    const { indexer } = await setup();
    expect(indexer.find({ types: ['xyz'] }).items.every((r) => (r.flags & 0x2) === 0)).toBe(true);
  });
});

describe('combined criteria in one query', () => {
  it('name + type + size + date + hidden/system agree with the oracle', async () => {
    const { indexer, entries } = await setup();
    const after = new Date(Date.UTC(2024, 0, 1) + 20 * DAY);
    const before = new Date(Date.UTC(2024, 0, 1) + 100 * DAY);
    const expected = entries.filter(
      (e) => e.ext === 'mp4' && e.size >= 30_000 && e.mtime >= after && e.mtime <= before && !e.hidden && !e.system
    );
    const got = allPages((page) =>
      indexer.find({ query: 'video', types: ['video'], minSize: 30_000n, after, before, includeHidden: false, includeSystem: false, page })
    );
    expect(names(got)).toEqual(desc(expected));
    expect(got.length).toBeGreaterThan(0);
  });

  it('search_by_date is newest-first and stable for equal timestamps', async () => {
    const { indexer, entries } = await setup();
    const got = allPages((page) => indexer.searchByDate(undefined, undefined, { page }));
    // $MFT and generated file #0 share a timestamp; ties are broken by record number, so the order is fixed
    // (search_by_date also lists directories; they are all stamped 2024-01-01 too, so drop them for the file oracle)
    const dirNames = ['.', 'Media', 'Docs', 'HiddenDir', 'SystemDir'];
    expect(got.length).toBe(130 + dirNames.length);
    expect(names(got).filter((n) => !dirNames.includes(n))).toEqual(byDateDesc(entries));
    const times = got.map((r) => r.modificationTime.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('path queries are paged and filtered like name queries', async () => {
    const { indexer, entries } = await setup();
    const p = indexer.search('media\\', { types: ['mp4'] });
    expect(p.total).toBe(entries.filter((e) => e.ext === 'mp4').length);
    expect(p.items.every((r) => r.fullPath!.startsWith('C:\\Media\\'))).toBe(true);
  });
});

describe('sizes that arrive via an extension record keep their hidden/system class', () => {
  it('a hidden file whose $DATA lives in an extension record is excluded from filtered directory sizes', async () => {
    const { CLUSTER, DIRECTORY, IN_USE, MemoryVolume, RECORD_SIZE, attributeList, buildRecord, dataResident, encodeRuns, fileNameAttr, nonResidentAttr, standardInfo, volumeData } =
      await import('./builder');
    const { MFTParser } = await import('../src/mft/parser');
    const image = Buffer.alloc(40 * CLUSTER);
    const at = 10 * CLUSTER;
    const put = (n: number, rec: Buffer) => rec.copy(image, at + n * RECORD_SIZE);
    const t = new Date('2024-03-03T00:00:00Z');
    const si = (a: number) => standardInfo({ c: t, m: t }, a);
    put(0, buildRecord({ attrs: [si(0x6), fileNameAttr('$MFT', 5, 3), nonResidentAttr(0x80, { lastVcn: 7n, runs: encodeRuns([{ clusters: 8, lcn: 10 }]), alloc: BigInt(8 * CLUSTER), real: BigInt(8 * CLUSTER) })] }));
    put(5, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x6), fileNameAttr('.', 5, 3)] }));
    put(24, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Dir', 5, 3)] }));
    put(28, buildRecord({ attrs: [si(0x22), fileNameAttr('secret.bin', 24, 3), attributeList()] })); // hidden, no $DATA here
    put(30, buildRecord({ baseRecord: 28, attrs: [nonResidentAttr(0x80, { lastVcn: 9n, alloc: 40960n, real: 40000n, runs: encodeRuns([{ clusters: 10, lcn: 20 }]) })] }));
    put(29, buildRecord({ attrs: [si(0x20), fileNameAttr('plain.txt', 24, 3), dataResident(100)] })); // (the $MFT has 32 record slots: 0..31)

    const mem = new MemoryVolume(image);
    const vol = volumeData({ mftStartLcn: 10n, mftValidDataLength: BigInt(8 * CLUSTER) });
    const indexer = new MFTIndexer('C', {}, { openParser: () => new MFTParser(mem, vol), dbPath: ':memory:' });
    await indexer.index();

    const dir = (h: boolean) => indexer.getLargestDirectories({ includeHidden: h }).items.find((d) => d.path === 'C:\\Dir')!;
    expect(dir(true).size).toBe(40_100n); // 40,000 (hidden, size from the extension record) + 100
    expect(dir(true).fileCount).toBe(2);
    expect(dir(false).size).toBe(100n); // the hidden file's size must not leak into the filtered total
    expect(dir(false).fileCount).toBe(1);
  });
});