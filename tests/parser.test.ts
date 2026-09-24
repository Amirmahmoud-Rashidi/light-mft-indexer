import { MFTParser, applyFixups, fileTimeToDate, parseDataRuns, parseMftRecord } from '../src/mft/parser';
import { FileAttributes } from '../src/mft/types';
import {
  CLUSTER, DIRECTORY, IN_USE, buildRecord, dataResident, encodeRuns, fileNameAttr, nonResidentAttr, standardInfo, toFileTime,
} from './builder';
import { LONG_NAME, T_CREATE, T_MODIFY, TOTAL_RECORDS, makeFakeVolume } from './fake-volume';

describe('applyFixups', () => {
  it('restores the real bytes of every 512-byte stripe', () => {
    const rec = buildRecord({ attrs: [fileNameAttr(LONG_NAME, 5)] });
    expect(applyFixups(rec)).toBe(true);
    // the name spans byte 510: after fixups the UTF-16 text must be intact
    expect(rec.toString('utf16le').includes(LONG_NAME)).toBe(true);
  });

  it('rejects a torn record (stripe does not carry the update sequence number)', () => {
    const rec = buildRecord({ attrs: [] });
    rec.writeUInt16LE(0xbeef, 1022);
    expect(applyFixups(rec)).toBe(false);
  });

  it('rejects an update sequence array that does not fit', () => {
    const rec = buildRecord({ attrs: [] });
    rec.writeUInt16LE(500, 6);
    expect(applyFixups(rec)).toBe(false);
  });
});

describe('parseDataRuns', () => {
  it('round-trips absolute, backwards (negative delta) and sparse runs', () => {
    const runs = [
      { clusters: 24, lcn: 0x5634 },
      { clusters: 8, lcn: 0x5614 }, // negative delta
      { clusters: 300, lcn: null }, // sparse
      { clusters: 1, lcn: 70000 }, // 3-byte delta
    ];
    const enc = encodeRuns(runs);
    const parsed = parseDataRuns(enc, 0, enc.length, CLUSTER);
    expect(parsed.map((r) => Number(r.length) / CLUSTER)).toEqual([24, 8, 300, 1]);
    expect(parsed.map((r) => r.isSparse)).toEqual([false, false, true, false]);
    expect(Number(parsed[0].offset) / CLUSTER).toBe(0x5634);
    expect(Number(parsed[1].offset) / CLUSTER).toBe(0x5614);
    expect(Number(parsed[3].offset) / CLUSTER).toBe(70000);
  });

  it('stops at the attribute boundary instead of reading corrupt data', () => {
    const enc = Buffer.from([0x21, 0x18, 0x34]); // header promises 3 more bytes than are available
    expect(parseDataRuns(enc, 0, enc.length, CLUSTER)).toEqual([]);
  });
});

describe('fileTimeToDate', () => {
  it('converts FILETIME to JS Date with millisecond accuracy', () => {
    expect(fileTimeToDate(toFileTime(T_CREATE)).toISOString()).toBe(T_CREATE.toISOString());
    expect(fileTimeToDate(116444736000000000n).getTime()).toBe(0);
  });
});

describe('parseMftRecord', () => {
  const si = () => standardInfo({ c: T_CREATE, m: T_MODIFY }, 0x22);

  it('reads header, times, attributes, name, parent and size', () => {
    const rec = parseMftRecord(
      buildRecord({ seq: 9, attrs: [si(), fileNameAttr('a.txt', 24, 3), dataResident(11)] }), 30, CLUSTER)!;
    expect(rec.recordNumber).toBe(30);
    expect(rec.sequenceNumber).toBe(9);
    expect(rec.fileName).toBe('a.txt');
    expect(rec.parentRecordNumber).toBe(24); // sequence number in the high 16 bits is stripped
    expect(rec.realSize).toBe(11n);
    expect(rec.allocatedSize).toBe(0n); // resident data uses no clusters
    expect(rec.creationTime.toISOString()).toBe(T_CREATE.toISOString());
    expect(rec.modificationTime.toISOString()).toBe(T_MODIFY.toISOString());
    expect(rec.fileAttributes & FileAttributes.HIDDEN).toBeTruthy();
    expect(rec.baseRecordNumber).toBe(0);
  });

  it('prefers the long Win32 name over the DOS 8.3 name, in either order', () => {
    const dosFirst = parseMftRecord(buildRecord({ attrs: [si(), fileNameAttr('LONGFI~1.TXT', 5, 2), fileNameAttr('long name.txt', 5, 1)] }), 1, CLUSTER)!;
    const dosLast = parseMftRecord(buildRecord({ attrs: [si(), fileNameAttr('long name.txt', 5, 1), fileNameAttr('LONGFI~1.TXT', 5, 2)] }), 1, CLUSTER)!;
    expect(dosFirst.fileName).toBe('long name.txt');
    expect(dosLast.fileName).toBe('long name.txt');
  });

  it('takes the size from the unnamed non-resident $DATA, not from stale $FILE_NAME data', () => {
    const rec = parseMftRecord(buildRecord({
      attrs: [si(), fileNameAttr('big.bin', 5, 3, { alloc: 1n, real: 2n }),
        nonResidentAttr(0x80, { lastVcn: 9n, alloc: 40960n, real: 40000n, runs: encodeRuns([{ clusters: 10, lcn: 50 }]) })],
    }), 1, CLUSTER)!;
    expect(rec.realSize).toBe(40000n);
    expect(rec.allocatedSize).toBe(40960n);
  });

  it('ignores alternate data streams when computing the size', () => {
    const rec = parseMftRecord(buildRecord({
      attrs: [si(), fileNameAttr('f.txt', 5, 3), dataResident(10),
        nonResidentAttr(0x80, { name: 'Zone.Identifier', alloc: 4096n, real: 999999n, runs: encodeRuns([{ clusters: 1, lcn: 5 }]) })],
    }), 1, CLUSTER)!;
    expect(rec.realSize).toBe(10n);
  });

  it('uses the compressed size as allocated size for compressed files', () => {
    const rec = parseMftRecord(buildRecord({
      attrs: [si(), fileNameAttr('c.bin', 5, 3),
        nonResidentAttr(0x80, { compressionUnit: 4, alloc: 1_000_000n, compressedSize: 123_456n, real: 900_000n, runs: encodeRuns([{ clusters: 5, lcn: 5 }]) })],
    }), 1, CLUSTER)!;
    expect(rec.realSize).toBe(900_000n);
    expect(rec.allocatedSize).toBe(123_456n);
  });

  it('reports directories with zero size and the directory flag', () => {
    const rec = parseMftRecord(buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(), fileNameAttr('Dir', 5, 3, { alloc: 4096n, real: 4096n })] }), 1, CLUSTER)!;
    expect(rec.flags & DIRECTORY).toBeTruthy();
    expect(rec.realSize).toBe(0n);
  });

  it('flags extension records and only trusts the first extent for sizes', () => {
    const ext = parseMftRecord(buildRecord({
      baseRecord: 31,
      attrs: [nonResidentAttr(0x80, { startVcn: 0n, lastVcn: 4n, real: 555n, alloc: 8192n, runs: encodeRuns([{ clusters: 5, lcn: 9 }]) })],
    }), 50, CLUSTER)!;
    expect(ext.baseRecordNumber).toBe(31);
    expect(ext.hasSizedData).toBe(true);
    const later = parseMftRecord(buildRecord({
      baseRecord: 31,
      attrs: [nonResidentAttr(0x80, { startVcn: 5n, lastVcn: 9n, real: 0n, runs: encodeRuns([{ clusters: 5, lcn: 19 }]) })],
    }), 51, CLUSTER)!;
    expect(later.hasSizedData).toBe(false);
  });

  it('returns null for free records, bad signatures and torn records', () => {
    expect(parseMftRecord(buildRecord({ flags: 0, attrs: [fileNameAttr('x', 5)] }), 1, CLUSTER)).toBeNull();
    expect(parseMftRecord(buildRecord({ signature: 'BAAD', attrs: [] }), 1, CLUSTER)).toBeNull();
    const torn = buildRecord({ attrs: [fileNameAttr('x', 5)] });
    torn.writeUInt16LE(0x1234, 510);
    expect(parseMftRecord(torn, 1, CLUSTER)).toBeNull();
    expect(parseMftRecord(Buffer.alloc(1024), 1, CLUSTER)).toBeNull();
  });

  it('survives garbage attribute chains without throwing', () => {
    const rec = buildRecord({ attrs: [fileNameAttr('x', 5)] });
    rec.writeUInt32LE(0xdeadbeef, 0x38 + 4); // absurd attribute length
    expect(() => parseMftRecord(rec, 1, CLUSTER)).not.toThrow();
  });
});

describe('MFTParser on a fragmented synthetic $MFT', () => {
  it('scans records across both $MFT fragments with few large reads', () => {
    const { mem, parser } = makeFakeVolume();
    const p = parser();
    expect(p.getRecordCount()).toBe(TOTAL_RECORDS);
    const seen = [...p.scan()].map((r) => r.recordNumber);
    expect(seen).toEqual([0, 5, 24, 30, 31, 32, 33, 40, 50, 61, 62, 63, 64, 65]); // 70 free, 71 torn, 72 garbage skipped
    expect(mem.reads).toBeLessThanOrEqual(3); // record 0 + one read per fragment, not one per record
  });

  it('reads a single record from the second fragment', () => {
    const { parser } = makeFakeVolume();
    const p = parser();
    expect(p.readMFTRecord(33)!.fileName).toBe('a.txt');
    expect(p.readMFTRecord(33)!.parentRecordNumber).toBe(32);
    expect(p.readMFTRecord(31)!.fileName).toBe('big.bin'); // last record of fragment A
    expect(p.readMFTRecord(9999)).toBeNull();
  });

  it('keeps names that cross the 512-byte fixup boundary intact', () => {
    const { parser } = makeFakeVolume();
    expect(parser().readMFTRecord(40)!.fileName).toBe(LONG_NAME + '.txt');
  });

  it('refuses an $MFT whose runs do not cover the whole stream', () => {
    const { mem, vol } = makeFakeVolume();
    // claim the MFT is longer than its runs describe (data continues in an extension record)
    const rec0 = mem.image.subarray(Number(vol.mftStartLcn) * CLUSTER, Number(vol.mftStartLcn) * CLUSTER + 1024);
    const attrOff = rec0.indexOf(Buffer.from([0x80, 0, 0, 0]), 0x38); // start of $DATA
    const withHole = Buffer.from(rec0);
    // lastVcn field (attr+24) -> larger than covered clusters
    withHole.writeBigUInt64LE(9999n, attrOff + 24);
    mem.image.set(withHole, Number(vol.mftStartLcn) * CLUSTER);
    expect(() => new MFTParser(mem, vol).getRecordCount()).toThrow(/fragmented|extension/);
  });
});
