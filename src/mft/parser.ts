// MFT Parser - reads and parses raw NTFS MFT records.
import {
  AttributeType,
  DataRun,
  FileAttributes,
  MFTRecordFlags,
  NtfsVolumeData,
  ParsedRecord,
  VolumeReader,
} from './types';
import { openVolume } from './win32';

const FILE_SIGNATURE = 0x454c4946; // 'FILE' (little endian)
const SECTOR_STRIDE = 512; // NTFS update-sequence stride is always 512 bytes
const RECORD_NUMBER_MASK = 0xffffffffffffn; // low 48 bits of a file reference
const FILETIME_EPOCH_DIFF = 116444736000000000n; // 100ns ticks between 1601-01-01 and 1970-01-01
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** Windows FILETIME (100ns since 1601) -> JS Date. */
export function fileTimeToDate(fileTime: bigint): Date {
  return new Date(Number((fileTime - FILETIME_EPOCH_DIFF) / 10000n));
}

/**
 * Undo the NTFS "update sequence" protection: the last two bytes of every 512-byte stripe were
 * replaced by the update sequence number and the real bytes live in the update sequence array.
 * Mutates `buf`. Returns false if the record is torn/corrupt (stripe check failed).
 */
export function applyFixups(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const usaOffset = buf.readUInt16LE(4);
  const usaCount = buf.readUInt16LE(6); // number of 16-bit entries, including the sequence number itself
  if (usaCount < 1) return false;
  const stripes = usaCount - 1;
  if (usaOffset + usaCount * 2 > buf.length || stripes * SECTOR_STRIDE > buf.length) return false;
  const usn = buf.readUInt16LE(usaOffset);
  for (let i = 1; i <= stripes; i++) {
    const end = i * SECTOR_STRIDE - 2;
    if (buf.readUInt16LE(end) !== usn) return false;
    buf[end] = buf[usaOffset + 2 * i];
    buf[end + 1] = buf[usaOffset + 2 * i + 1];
  }
  return true;
}

/**
 * Decode a data-run list. `end` bounds the attribute so a corrupt list cannot run into other data.
 * Returned offsets/lengths are in bytes.
 */
export function parseDataRuns(buf: Buffer, offset: number, end: number, bytesPerCluster: number): DataRun[] {
  const runs: DataRun[] = [];
  const bpc = BigInt(bytesPerCluster);
  let pos = offset;
  let lcn = 0n;
  end = Math.min(end, buf.length);

  while (pos < end) {
    const header = buf[pos];
    if (header === 0) break;
    const lenBytes = header & 0x0f;
    const offBytes = header >> 4;
    if (lenBytes === 0 || lenBytes > 8 || offBytes > 8 || pos + 1 + lenBytes + offBytes > end) break; // corrupt
    pos++;

    let clusters = 0n;
    for (let i = 0; i < lenBytes; i++) clusters |= BigInt(buf[pos + i]) << (8n * BigInt(i));
    pos += lenBytes;

    if (offBytes === 0) {
      runs.push({ length: clusters * bpc, offset: 0n, isSparse: true });
      continue;
    }

    let delta = 0n;
    for (let i = 0; i < offBytes; i++) delta |= BigInt(buf[pos + i]) << (8n * BigInt(i));
    pos += offBytes;
    if (delta & (1n << (8n * BigInt(offBytes) - 1n))) delta -= 1n << (8n * BigInt(offBytes)); // sign extend
    lcn += delta;
    runs.push({ length: clusters * bpc, offset: lcn * bpc, isSparse: false });
  }
  return runs;
}

export interface ParseRecordOptions {
  /** Also decode the data runs of the unnamed $DATA attribute (needed for the $MFT record itself). */
  wantDataRuns?: boolean;
}

// $FILE_NAME namespaces: 0 POSIX, 1 Win32, 2 DOS (8.3), 3 Win32&DOS. Prefer the long name.
function nameRank(nameType: number): number {
  if (nameType === 1 || nameType === 3) return 2;
  if (nameType === 0) return 1;
  return 0;
}

/**
 * Parse one raw MFT record. `buf` must be exactly one record and is modified in place (fixups).
 * Returns null for free records, corrupt records, or anything that is not a 'FILE' record.
 */
export function parseMftRecord(
  buf: Buffer,
  recordNumber: number,
  bytesPerCluster: number,
  options: ParseRecordOptions = {}
): ParsedRecord | null {
  if (buf.length < 0x30 || buf.readUInt32LE(0) !== FILE_SIGNATURE) return null;
  const flags = buf.readUInt16LE(0x16);
  if (!(flags & MFTRecordFlags.IN_USE)) return null;
  if (!applyFixups(buf)) return null;

  const sequenceNumber = buf.readUInt16LE(0x10);
  const linkCount = buf.readUInt16LE(0x12);
  const firstAttribute = buf.readUInt16LE(0x14);
  const usedSize = buf.readUInt32LE(0x18);
  const baseRecordNumber = Number(buf.readBigUInt64LE(0x20) & RECORD_NUMBER_MASK);
  const limit = Math.min(usedSize, buf.length);

  let si: { c: bigint; m: bigint; r: bigint; a: bigint; attrs: number } | undefined;
  let name:
    | { rank: number; parent: bigint; text: string; c: bigint; m: bigint; r: bigint; a: bigint;
        alloc: bigint; real: bigint; attrs: number }
    | undefined;
  let hasSizedData = false;
  let dataReal = 0n;
  let dataAlloc = 0n;
  let hasAttributeList = false;
  let dataRuns: DataRun[] | undefined;
  let dataLastVcn: bigint | undefined;

  let off = firstAttribute;
  while (off + 8 <= limit) {
    const type = buf.readUInt32LE(off);
    if (type === 0xffffffff) break;
    const len = buf.readUInt32LE(off + 4);
    if (len < 24 || (len & 7) !== 0 || off + len > limit) break; // corrupt attribute chain

    const nonResident = buf[off + 8] !== 0;
    const nameLength = buf[off + 9];

    if (type === AttributeType.ATTRIBUTE_LIST) {
      hasAttributeList = true;
    } else if (!nonResident && (type === AttributeType.STANDARD_INFORMATION || type === AttributeType.FILE_NAME)) {
      const valueLength = buf.readUInt32LE(off + 16);
      const v = off + buf.readUInt16LE(off + 20);
      if (v + valueLength <= off + len) {
        if (type === AttributeType.STANDARD_INFORMATION && valueLength >= 36) {
          si = {
            c: buf.readBigUInt64LE(v),
            m: buf.readBigUInt64LE(v + 8),
            r: buf.readBigUInt64LE(v + 16),
            a: buf.readBigUInt64LE(v + 24),
            attrs: buf.readUInt32LE(v + 32),
          };
        } else if (type === AttributeType.FILE_NAME && valueLength >= 66) {
          const chars = buf[v + 64];
          const nameType = buf[v + 65];
          if (66 + chars * 2 <= valueLength) {
            const rank = nameRank(nameType);
            if (!name || rank > name.rank) {
              name = {
                rank,
                parent: buf.readBigUInt64LE(v) & RECORD_NUMBER_MASK,
                c: buf.readBigUInt64LE(v + 8),
                m: buf.readBigUInt64LE(v + 16),
                r: buf.readBigUInt64LE(v + 24),
                a: buf.readBigUInt64LE(v + 32),
                alloc: buf.readBigUInt64LE(v + 40),
                real: buf.readBigUInt64LE(v + 48),
                attrs: buf.readUInt32LE(v + 56),
                text: buf.toString('utf16le', v + 66, v + 66 + chars * 2),
              };
            }
          }
        }
      }
    } else if (type === AttributeType.DATA && nameLength === 0) {
      // Only the unnamed stream defines the file size (named streams are alternate data streams).
      if (!nonResident) {
        dataReal = BigInt(buf.readUInt32LE(off + 16));
        dataAlloc = 0n; // resident data occupies no clusters
        hasSizedData = true;
      } else if (len >= 64) {
        const startVcn = buf.readBigUInt64LE(off + 16);
        if (startVcn === 0n) {
          // Only the first extent carries valid size fields.
          dataReal = buf.readBigUInt64LE(off + 48);
          dataAlloc = buf.readBigUInt64LE(off + 40);
          const compressionUnit = buf.readUInt16LE(off + 34);
          if (compressionUnit !== 0 && len >= 72) dataAlloc = buf.readBigUInt64LE(off + 64); // compressed size
          hasSizedData = true;
          if (options.wantDataRuns) {
            dataLastVcn = buf.readBigUInt64LE(off + 24);
            dataRuns = parseDataRuns(buf, off + buf.readUInt16LE(off + 32), off + len, bytesPerCluster);
          }
        }
      }
    }
    off += len;
  }

  const isDirectory = (flags & MFTRecordFlags.DIRECTORY) !== 0;
  const epoch = new Date(0);
  const record: ParsedRecord = {
    recordNumber,
    sequenceNumber,
    flags: flags as MFTRecordFlags,
    linkCount,
    attributeOffset: firstAttribute,
    fileName: name ? name.text : '',
    parentRecordNumber: name ? Number(name.parent) : 0,
    creationTime: si ? fileTimeToDate(si.c) : name ? fileTimeToDate(name.c) : epoch,
    modificationTime: si ? fileTimeToDate(si.m) : name ? fileTimeToDate(name.m) : epoch,
    mftModificationTime: si ? fileTimeToDate(si.r) : name ? fileTimeToDate(name.r) : epoch,
    accessTime: si ? fileTimeToDate(si.a) : name ? fileTimeToDate(name.a) : epoch,
    fileAttributes: (si ? si.attrs : name ? name.attrs : FileAttributes.NORMAL) as FileAttributes,
    // Directories carry index sizes, not file sizes -> report 0. For files prefer $DATA over the
    // (often stale) sizes cached in $FILE_NAME.
    allocatedSize: isDirectory ? 0n : hasSizedData ? dataAlloc : name ? name.alloc : 0n,
    realSize: isDirectory ? 0n : hasSizedData ? dataReal : name ? name.real : 0n,
    baseRecordNumber,
    hasSizedData,
    hasAttributeList,
    dataRuns,
    dataLastVcn,
  };
  return record;
}

interface MftLayout {
  runs: DataRun[];
  starts: number[]; // stream offset at which each run begins
  totalBytes: number; // size of the $MFT stream
  recordCount: number;
}

/** Reads and parses the whole $MFT of an NTFS volume. */
export class MFTParser {
  private layout?: MftLayout;

  constructor(
    private readonly reader: VolumeReader,
    private readonly volumeData: NtfsVolumeData
  ) {}

  /** Open a real Windows volume (needs Administrator). */
  static open(driveLetter: string): MFTParser {
    const volume = openVolume(driveLetter);
    return new MFTParser(volume, volume.volumeData);
  }

  close(): void {
    this.reader.close();
  }

  getVolumeData(): NtfsVolumeData {
    return this.volumeData;
  }

  get recordSize(): number {
    return this.volumeData.bytesPerFileRecordSegment;
  }

  /** Locate the $MFT itself: record 0 lists the extents where the whole MFT is stored. */
  private getLayout(): MftLayout {
    if (this.layout) return this.layout;
    const v = this.volumeData;
    const recSize = v.bytesPerFileRecordSegment;
    if (recSize < 512 || recSize > 65536 || v.bytesPerCluster < 512) {
      throw new Error(`Unexpected NTFS geometry (record ${recSize} B, cluster ${v.bytesPerCluster} B)`);
    }

    const raw = this.reader.read(v.mftStartLcn * BigInt(v.bytesPerCluster), recSize);
    const rec = parseMftRecord(raw, 0, v.bytesPerCluster, { wantDataRuns: true });
    if (!rec) throw new Error('$MFT record 0 is missing or corrupt');
    if (!rec.dataRuns || rec.dataRuns.length === 0 || rec.dataLastVcn === undefined) {
      throw new Error(
        'Could not read the $MFT data runs from record 0' +
          (rec.hasAttributeList ? ' ($MFT uses an $ATTRIBUTE_LIST, which is not supported yet)' : '')
      );
    }

    // The runs must cover the entire stream; otherwise part of $MFT lives in extension records.
    const coveredClusters = rec.dataRuns.reduce((n, r) => n + r.length / BigInt(v.bytesPerCluster), 0n);
    if (coveredClusters !== rec.dataLastVcn + 1n) {
      throw new Error('$MFT is too fragmented (its data runs continue in extension records), which is not supported yet');
    }

    const starts: number[] = [];
    let total = 0;
    for (const run of rec.dataRuns) {
      starts.push(total);
      total += Number(run.length);
    }
    let usable = Number(rec.realSize) > 0 ? Math.min(total, Number(rec.realSize)) : total;
    if (v.mftValidDataLength > 0n) usable = Math.min(usable, Number(v.mftValidDataLength));

    this.layout = {
      runs: rec.dataRuns,
      starts,
      totalBytes: total,
      recordCount: Math.floor(usable / recSize),
    };
    return this.layout;
  }

  /** Number of MFT record slots (including free ones). */
  getRecordCount(): number {
    return this.getLayout().recordCount;
  }

  /** Read bytes from the (possibly fragmented) $MFT stream. */
  private readStream(offset: number, length: number): Buffer {
    const { runs, starts, totalBytes } = this.getLayout();
    if (offset >= totalBytes) return Buffer.alloc(0);
    length = Math.min(length, totalBytes - offset);
    const out = Buffer.alloc(length);

    // binary search: last run whose start <= offset
    let lo = 0;
    let hi = runs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }

    let written = 0;
    for (let i = lo; i < runs.length && written < length; i++) {
      const skip = Math.max(offset + written - starts[i], 0);
      const n = Math.min(Number(runs[i].length) - skip, length - written);
      if (n <= 0) continue;
      if (!runs[i].isSparse) {
        this.reader.read(runs[i].offset + BigInt(skip), n).copy(out, written);
      } // sparse runs read as zeros
      written += n;
    }
    return out;
  }

  /** Read and parse one record by number (null if free/corrupt/out of range). */
  readMFTRecord(recordNumber: number): ParsedRecord | null {
    const recSize = this.recordSize;
    if (recordNumber < 0 || recordNumber >= this.getRecordCount()) return null;
    const buf = this.readStream(recordNumber * recSize, recSize);
    return buf.length === recSize ? parseMftRecord(buf, recordNumber, this.volumeData.bytesPerCluster) : null;
  }

  /** Stream every in-use record (base and extension records) in MFT order. */
  *scan(): Generator<ParsedRecord, void, undefined> {
    const recSize = this.recordSize;
    const bpc = this.volumeData.bytesPerCluster;
    const total = this.getRecordCount();
    const perChunk = Math.max(1, Math.floor(SCAN_CHUNK_BYTES / recSize));

    for (let first = 0; first < total; first += perChunk) {
      const count = Math.min(perChunk, total - first);
      const buf = this.readStream(first * recSize, count * recSize);
      for (let i = 0; i < count; i++) {
        const rec = parseMftRecord(buf.subarray(i * recSize, (i + 1) * recSize), first + i, bpc);
        if (rec) yield rec;
      }
    }
  }
}

export function createMFTParser(driveLetter: string): MFTParser {
  return MFTParser.open(driveLetter);
}

