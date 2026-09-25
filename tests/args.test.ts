import { parseBool, parseDate, parseFilter, parseSize, parseTypes } from '../src/mft/args';
import { parsePage } from '../src/mft/indexer';

describe('parseSize', () => {
  it.each([
    ['1048576', 1048576n], [1048576, 1048576n], ['500MB', 500n * 1024n ** 2n], ['1.5GB', 1610612736n], ['100kb', 102400n],
    ['10 KB', 10240n], ['2tb', 2n * 1024n ** 4n], ['0', 0n], ['12B', 12n],
  ])('%p -> %p', (input, expected) => expect(parseSize('size', input)).toBe(expected));

  it('keeps exactness above 2^53 for plain digit strings', () => {
    expect(parseSize('size', '9007199254740993')).toBe(9007199254740993n);
  });
  it('treats empty as "not given"', () => {
    for (const v of [undefined, null, '']) expect(parseSize('size', v)).toBeUndefined();
  });
  it.each(['abc', '-5', '1.2.3', '5 parsecs', '1e6', 1.5, -1, {}])('rejects %p', (v) => {
    expect(() => parseSize('minSize', v)).toThrow(/Invalid minSize/);
  });
});

describe('parseDate', () => {
  it('parses ISO dates and datetimes', () => {
    expect(parseDate('after', '2025-01-31')!.toISOString()).toBe('2025-01-31T00:00:00.000Z');
    expect(parseDate('after', '2025-01-31T12:30:00Z')!.toISOString()).toBe('2025-01-31T12:30:00.000Z');
  });
  it('a bare "before" date means the end of that day, a full timestamp is left alone', () => {
    expect(parseDate('before', '2025-01-31', true)!.toISOString()).toBe('2025-01-31T23:59:59.999Z');
    expect(parseDate('before', '2025-01-31T10:00:00Z', true)!.toISOString()).toBe('2025-01-31T10:00:00.000Z');
  });
  it('rejects garbage and treats empty as not given', () => {
    expect(() => parseDate('after', 'yesterday-ish')).toThrow(/Invalid after/);
    expect(parseDate('after', undefined)).toBeUndefined();
    expect(parseDate('after', '')).toBeUndefined();
  });
});

describe('parseTypes / parseBool / parsePage', () => {
  it('accepts arrays and comma/space separated strings', () => {
    expect(parseTypes(['video', 'iso'])).toEqual(['video', 'iso']);
    expect(parseTypes('video, iso;.xyz')).toEqual(['video', 'iso', '.xyz']);
    expect(parseTypes(undefined)).toBeUndefined();
    expect(() => parseTypes([1, 2])).toThrow(/Invalid types/);
    expect(() => parseTypes(42)).toThrow(/Invalid types/);
  });
  it('parseBool accepts booleans and "true"/"false"', () => {
    expect([parseBool('x', true), parseBool('x', false), parseBool('x', 'true'), parseBool('x', 'false'), parseBool('x', undefined)])
      .toEqual([true, false, true, false, undefined]);
    expect(() => parseBool('includeHidden', 'maybe')).toThrow(/Invalid includeHidden/);
    expect(() => parseBool('includeHidden', 1)).toThrow(/Invalid includeHidden/);
  });
  it('parsePage defaults to 1 and validates', () => {
    expect([parsePage(undefined), parsePage(null), parsePage(''), parsePage(3), parsePage('4')]).toEqual([1, 1, 1, 3, 4]);
    for (const bad of [0, -2, 2.5, 'x', NaN]) expect(() => parsePage(bad)).toThrow(/page must be an integer >= 1/);
  });
  it('parseFilter combines them (defaults stay undefined so "include" remains the default)', () => {
    expect(parseFilter({})).toEqual({ includeHidden: undefined, includeSystem: undefined, types: undefined, page: 1 });
    expect(parseFilter({ includeHidden: 'false', types: 'video', page: '2' }))
      .toEqual({ includeHidden: false, includeSystem: undefined, types: ['video'], page: 2 });
  });
});