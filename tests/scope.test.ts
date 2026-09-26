import { buildScope, isEmptyScope, nameInScope, pathInScope } from '../src/mft/scope';

describe('buildScope: parsing', () => {
  it('is "none" with no entries', () => {
    expect(buildScope('C', undefined, undefined).mode).toBe('none');
    expect(buildScope('C', [], []).mode).toBe('none');
    expect(isEmptyScope(buildScope('C', [], []))).toBe(true);
  });

  it('rejects only + exclude together', () => {
    expect(() => buildScope('C', ['C:\\a'], ['C:\\b'])).toThrow(/either "only" or "exclude"/);
  });

  it('auto-detects a path entry (contains \\\\ or /) vs a name pattern', () => {
    const s = buildScope('C', undefined, ['C:\\Windows', 'node_modules', '*.tmp', 'a/b']);
    expect(s.paths).toHaveLength(2); // C:\Windows, a/b
    expect(s.namePatterns).toHaveLength(2); // node_modules, *.tmp
  });

  it('accepts a path without a drive prefix and anchors it at the given drive', () => {
    const s = buildScope('C', undefined, ['Users\\me\\Downloads']);
    expect(pathInScope(s, 'C:\\Users\\me\\Downloads\\file.txt')).toBe(true);
  });

  it('rejects a path on a different drive', () => {
    expect(() => buildScope('C', undefined, ['D:\\Data'])).toThrow(/not on drive C/);
  });

  it('ignores blank entries', () => {
    expect(isEmptyScope(buildScope('C', undefined, ['', '  ']))).toBe(true);
  });
});

describe('nameInScope', () => {
  it('matches an exact name and glob patterns, case-insensitively', () => {
    const s = buildScope('C', undefined, ['node_modules', '*.tmp', 'cache?']);
    expect(nameInScope(s, 'node_modules')).toBe(true);
    expect(nameInScope(s, 'NODE_MODULES')).toBe(true);
    expect(nameInScope(s, 'other')).toBe(false);
    expect(nameInScope(s, 'file.tmp')).toBe(true);
    expect(nameInScope(s, 'file.TMP')).toBe(true);
    expect(nameInScope(s, 'file.tmpx')).toBe(false);
    expect(nameInScope(s, 'cache1')).toBe(true);
    expect(nameInScope(s, 'cache12')).toBe(false);
  });
});

describe('pathInScope', () => {
  it('matches the path itself and anything below it, case-insensitively', () => {
    const s = buildScope('C', undefined, ['C:\\Users\\me\\Downloads']);
    expect(pathInScope(s, 'C:\\Users\\me\\Downloads')).toBe(true);
    expect(pathInScope(s, 'c:\\users\\me\\downloads')).toBe(true);
    expect(pathInScope(s, 'C:\\Users\\me\\Downloads\\sub\\file.txt')).toBe(true);
    expect(pathInScope(s, 'C:\\Users\\me\\Downloads2')).toBe(false); // prefix, not a path segment
    expect(pathInScope(s, 'C:\\Users\\me')).toBe(false);
  });

  it('normalizes slashes and trailing separators', () => {
    const s = buildScope('C', undefined, ['C:/Users/me/Downloads/']);
    expect(pathInScope(s, 'C:\\Users\\me\\Downloads\\x')).toBe(true);
  });
});