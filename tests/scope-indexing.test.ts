import { MFTIndexer } from '../src/mft/indexer';
import { ALL_FILES, makeScopeVolume } from './scope-volume';

async function index(options: any) {
  const fake = makeScopeVolume();
  const indexer = new MFTIndexer('C', options, { openParser: () => fake.parser(), dbPath: ':memory:' });
  const stats = await indexer.index();
  return { indexer, stats };
}
const names = (indexer: MFTIndexer) => indexer.find({}).items.filter((r) => (r.flags & 0x2) === 0).map((r) => r.fileName).sort();

describe('index scope: no restriction (default, unchanged behavior)', () => {
  it('indexes everything and reports no scope', async () => {
    const { indexer, stats } = await index({});
    expect(names(indexer)).toEqual([...ALL_FILES].sort());
    expect(stats.scope).toBeUndefined();
  });
});

describe('index scope: --exclude', () => {
  it('excludes by path, including everything below it', async () => {
    const { indexer, stats } = await index({ exclude: ['C:\\Downloads'] });
    expect(names(indexer)).toEqual(['$MFT', 'app.js', 'deep.txt', 'pkg.json', 'temp.tmp'].sort());
    expect(indexer.getLargestDirectories().items.map((d) => d.path)).not.toContain('C:\\Downloads');
    expect(stats.scope).toEqual({ mode: 'exclude', entries: ['C:\\Downloads'] });
  });

  it('excludes a nested path, keeping siblings', async () => {
    const { indexer } = await index({ exclude: ['C:\\Projects\\sub'] });
    expect(names(indexer)).toEqual(['$MFT', 'app.js', 'inner.js', 'pkg.json', 'report.pdf', 'temp.tmp'].sort());
  });

  it('excludes by name pattern everywhere it occurs (both node_modules dirs)', async () => {
    const { indexer } = await index({ exclude: ['node_modules'] });
    expect(names(indexer)).toEqual(['$MFT', 'app.js', 'deep.txt', 'report.pdf', 'temp.tmp'].sort());
  });

  it('excludes by glob pattern (*.tmp)', async () => {
    const { indexer } = await index({ exclude: ['*.tmp'] });
    expect(names(indexer)).not.toContain('temp.tmp');
    expect(names(indexer)).toHaveLength(6); // 7 total ($MFT + 6 files) minus temp.tmp
  });

  it('combines a path and a name pattern in one --exclude', async () => {
    const { indexer } = await index({ exclude: ['C:\\Downloads', '*.tmp'] });
    expect(names(indexer)).toEqual(['$MFT', 'app.js', 'deep.txt', 'pkg.json'].sort());
  });

  it('accepts a drive-relative path (without "C:")', async () => {
    const { indexer } = await index({ exclude: ['Downloads'] });
    expect(names(indexer)).toEqual(['$MFT', 'app.js', 'deep.txt', 'pkg.json', 'temp.tmp'].sort());
  });
});

describe('index scope: --only', () => {
  it('keeps only the given path, including everything below it', async () => {
    const { indexer, stats } = await index({ only: ['C:\\Projects'] });
    expect(names(indexer)).toEqual(['app.js', 'deep.txt'].sort());
    expect(stats.scope).toEqual({ mode: 'only', entries: ['C:\\Projects'] });
  });

  it('keeps only a nested subdirectory', async () => {
    const { indexer } = await index({ only: ['C:\\Projects\\sub'] });
    expect(names(indexer)).toEqual(['deep.txt']);
  });

  it('keeps only files matching a name pattern, wherever they are', async () => {
    const { indexer } = await index({ only: ['*.js'] });
    expect(names(indexer)).toEqual(['app.js', 'inner.js'].sort());
  });

  it('combines two --only paths (union)', async () => {
    const { indexer } = await index({ only: ['C:\\Projects', 'C:\\Downloads'] });
    expect(names(indexer)).toEqual(['app.js', 'deep.txt', 'inner.js', 'report.pdf'].sort());
  });

  it('an --only path with nothing in it yields an empty (but valid) index', async () => {
    const { indexer, stats } = await index({ only: ['C:\\node_modules'] });
    expect(names(indexer)).toEqual(['pkg.json']);
    expect(stats.totalFiles).toBe(1);
  });

  it('directories outside the --only path are still resolvable as ancestors, and recursive sizes still roll up through them', async () => {
    const { indexer } = await index({ only: ['C:\\Projects\\sub'] });
    const dirs = indexer.getLargestDirectories().items;
    // "Projects" itself has no files DIRECTLY inside it, but "deep.txt" is below it via "sub", so its
    // recursive (tree) size is non-zero and it is correctly reported too - only its own direct file count is 0.
    expect(dirs.map((d) => d.path).sort()).toEqual(['C:\\Projects', 'C:\\Projects\\sub']);
    expect(dirs.find((d) => d.path === 'C:\\Projects')!.size).toBe(20n); // deep.txt, via "sub"
    expect(dirs.find((d) => d.path === 'C:\\Projects\\sub')!.size).toBe(20n);
  });

  it('an --only directory excludes sibling subtrees, keeping only what is actually below it', async () => {
    const { indexer } = await index({ only: ['C:\\Downloads'] });
    const dirs = indexer.getLargestDirectories().items;
    // Downloads\node_modules is INSIDE the --only path (inner.js is kept); the top-level node_modules is not.
    expect(dirs.map((d) => d.path).sort()).toEqual(['C:\\Downloads', 'C:\\Downloads\\node_modules']);
    expect(dirs.map((d) => d.path)).not.toContain('C:\\node_modules');
  });
});

describe('index scope: validation and interaction with hidden/system filters', () => {
  it('rejects only + exclude together', async () => {
    const fake = makeScopeVolume();
    const indexer = new MFTIndexer('C', { only: ['C:\\Projects'], exclude: ['C:\\Downloads'] }, { openParser: () => fake.parser(), dbPath: ':memory:' });
    await expect(indexer.index()).rejects.toThrow(/either "only" or "exclude"/);
  });

  it('includeHidden/includeSystem passed to index() combine with --only/--exclude (both narrow what gets indexed)', async () => {
    const { makeBigVolume } = await import('./big-volume');
    const big = makeBigVolume(20);
    const withHidden = new MFTIndexer('C', { only: ['C:\\Media'] }, { openParser: () => big.parser(), dbPath: ':memory:' });
    const withHiddenStats = await withHidden.index();
    const big2 = makeBigVolume(20);
    const noHidden = new MFTIndexer('C', { only: ['C:\\Media'], includeHidden: false }, { openParser: () => big2.parser(), dbPath: ':memory:' });
    const noHiddenStats = await noHidden.index();
    // both are scoped to Media only, but excluding hidden files at index time yields strictly fewer files
    expect(noHiddenStats.totalFiles).toBeLessThan(withHiddenStats.totalFiles);
    const HIDDEN = 0x2;
    expect(noHidden.find({}).items.filter((r) => (r.flags & 0x2) === 0).every((r) => (r.fileAttributes & HIDDEN) === 0)).toBe(true);
    expect(withHidden.find({}).items.filter((r) => (r.flags & 0x2) === 0).some((r) => (r.fileAttributes & HIDDEN) !== 0)).toBe(true);
  });

  it('scope persists across getStats() (survives reopening the same db)', async () => {
    const { indexer } = await index({ exclude: ['node_modules'] });
    expect(indexer.getStats()!.scope).toEqual({ mode: 'exclude', entries: ['node_modules'] });
  });

  it('re-indexing without scope after a scoped index clears the previous scope', async () => {
    const fake = makeScopeVolume();
    const dbPath = ':memory:';
    const indexer = new MFTIndexer('C', {}, { openParser: () => fake.parser(), dbPath });
    await indexer.index({ exclude: ['node_modules'] });
    expect(indexer.getStats()!.scope?.mode).toBe('exclude');
    const fake2 = makeScopeVolume();
    (indexer as any).openParser = () => fake2.parser();
    await indexer.index({});
    expect(indexer.getStats()!.scope).toBeUndefined();
    expect(names(indexer)).toEqual([...ALL_FILES].sort());
  });
});