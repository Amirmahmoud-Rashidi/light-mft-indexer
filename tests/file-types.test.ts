import { FILE_TYPE_CATEGORIES, extensionOf, listCategories, resolveTypes } from '../src/mft/file-types';

describe('extensionOf', () => {
  it.each([
    ['movie.MP4', 'mp4'], ['archive.tar.gz', 'gz'], ['.gitignore', 'gitignore'], ['noext', ''],
    ['trailingdot.', ''], ['a.b.c.TXT', 'txt'], ['', ''],
  ])('%s -> %j', (name, ext) => expect(extensionOf(name)).toBe(ext));
});

describe('resolveTypes', () => {
  it('expands preset categories', () => {
    const r = resolveTypes(['video']);
    expect(r.extensions).toEqual(expect.arrayContaining(['mp4', 'mkv', 'avi']));
    expect(r.includeFolders).toBe(false);
    expect(r.labels).toEqual(['video']);
  });

  it('understands common aliases and is case-insensitive', () => {
    for (const alias of ['videos', 'Movies', 'FILM']) expect(resolveTypes([alias]).labels).toEqual(['video']);
    for (const alias of ['pictures', 'photos', 'Images']) expect(resolveTypes([alias]).labels).toEqual(['image']);
    expect(resolveTypes(['docs']).labels).toEqual(['document']);
    expect(resolveTypes(['music']).labels).toEqual(['audio']);
    expect(resolveTypes(['compressed']).labels).toEqual(['archive']);
  });

  it('treats unknown tokens as custom extensions in any spelling', () => {
    for (const t of ['xyz', '.xyz', '*.xyz', 'XYZ', ' .Xyz ']) {
      expect(resolveTypes([t])).toMatchObject({ extensions: ['xyz'], labels: ['.xyz'] });
    }
  });

  it('mixes presets, folders and custom extensions without duplicates', () => {
    const r = resolveTypes(['video', 'mp4', 'folder', '.xyz']);
    expect(r.includeFolders).toBe(true);
    expect(r.extensions.filter((e) => e === 'mp4')).toHaveLength(1);
    expect(r.extensions).toContain('xyz');
  });

  it('ignores blanks and returns "no filter" for empty input', () => {
    expect(resolveTypes(undefined)).toMatchObject({ extensions: [], includeFolders: false });
    expect(resolveTypes(['', '  '])).toMatchObject({ extensions: [], includeFolders: false });
  });

  it('rejects tokens that cannot be extensions (path characters, wildcards, spaces)', () => {
    for (const bad of ['a/b', 'a\\b', 'x y', 'a*b', 'a?b', 'a:b', '<x>']) {
      expect(() => resolveTypes([bad])).toThrow(/Invalid file type/);
    }
  });

  it('presets are well formed: lower case, no dots, no cross-category duplicates except deliberate ones', () => {
    const seen = new Map<string, string>();
    for (const [category, exts] of Object.entries(FILE_TYPE_CATEGORIES)) {
      for (const e of exts) {
        expect(e).toMatch(/^[a-z0-9]+$/);
        if (seen.has(e)) throw new Error(`.${e} is in both ${seen.get(e)} and ${category}`);
        seen.set(e, category);
      }
    }
    expect(listCategories()).toEqual(expect.arrayContaining(['image', 'video', 'audio', 'document', 'archive', 'code']));
  });
});