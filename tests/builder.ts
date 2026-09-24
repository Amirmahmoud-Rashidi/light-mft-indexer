// Helpers that build byte-exact synthetic NTFS structures for tests.
import { NtfsVolumeData, VolumeReader } from '../src/mft/types';

export const CLUSTER = 4096;
export const RECORD_SIZE = 1024;
const FILETIME_EPOCH = 116444736000000000n;

export const toFileTime = (d: Date): bigint => BigInt(d.getTime()) * 10000n + FILETIME_EPOCH;
const align8 = (n: number) => (n + 7) & ~7;

// ---- attributes -----------------------------------------------------------------------------
export function residentAttr(type: number, value: Buffer, id = 0, name = ''): Buffer {
  const nameBytes = Buffer.from(name, 'utf16le');
  const valueOffset = align8(24 + nameBytes.length);
  const buf = Buffer.alloc(align8(valueOffset + value.length));
  buf.writeUInt32LE(type, 0);
  buf.writeUInt32LE(buf.length, 4);
  buf[8] = 0; // resident
  buf[9] = name.length;
  buf.writeUInt16LE(24, 10);
  buf.writeUInt16LE(id, 14);
  buf.writeUInt32LE(value.length, 16);
  buf.writeUInt16LE(valueOffset, 20);
  nameBytes.copy(buf, 24);
  value.copy(buf, valueOffset);
  return buf;
}

export interface NonResidentOpts {
  startVcn?: bigint; lastVcn?: bigint; runs?: Buffer; alloc?: bigint; real?: bigint; init?: bigint;
  compressionUnit?: number; compressedSize?: bigint; name?: string;
}
export function nonResidentAttr(type: number, o: NonResidentOpts = {}): Buffer {
  const nameBytes = Buffer.from(o.name ?? '', 'utf16le');
  const compressed = (o.compressionUnit ?? 0) !== 0;
  const headerSize = compressed ? 72 : 64;
  const runsOffset = align8(headerSize + nameBytes.length);
  const runs = o.runs ?? Buffer.from([0]);
  const buf = Buffer.alloc(align8(runsOffset + runs.length));
  buf.writeUInt32LE(type, 0);
  buf.writeUInt32LE(buf.length, 4);
  buf[8] = 1;
  buf[9] = (o.name ?? '').length;
  buf.writeUInt16LE(headerSize, 10); // name offset
  buf.writeBigUInt64LE(o.startVcn ?? 0n, 16);
  buf.writeBigUInt64LE(o.lastVcn ?? 0n, 24);
  buf.writeUInt16LE(runsOffset, 32);
  buf.writeUInt16LE(o.compressionUnit ?? 0, 34);
  buf.writeBigUInt64LE(o.alloc ?? 0n, 40);
  buf.writeBigUInt64LE(o.real ?? 0n, 48);
  buf.writeBigUInt64LE(o.init ?? o.real ?? 0n, 56);
  if (compressed) buf.writeBigUInt64LE(o.compressedSize ?? 0n, 64);
  nameBytes.copy(buf, headerSize);
  runs.copy(buf, runsOffset);
  return buf;
}

export function standardInfo(times: { c: Date; m: Date; r?: Date; a?: Date }, attrs = 0x20): Buffer {
  const v = Buffer.alloc(72);
  v.writeBigUInt64LE(toFileTime(times.c), 0);
  v.writeBigUInt64LE(toFileTime(times.m), 8);
  v.writeBigUInt64LE(toFileTime(times.r ?? times.m), 16);
  v.writeBigUInt64LE(toFileTime(times.a ?? times.m), 24);
  v.writeUInt32LE(attrs, 32);
  return residentAttr(0x10, v);
}

/** nameType: 0 POSIX, 1 Win32, 2 DOS, 3 Win32&DOS */
export function fileNameAttr(name: string, parent: number, nameType = 1, sizes = { alloc: 0n, real: 0n }, attrs = 0x20, seq = 1): Buffer {
  const nb = Buffer.from(name, 'utf16le');
  const v = Buffer.alloc(66 + nb.length);
  v.writeBigUInt64LE(BigInt(parent) | (BigInt(seq) << 48n), 0);
  const t = toFileTime(new Date('2001-01-01T00:00:00Z')); // stale times on purpose
  for (const off of [8, 16, 24, 32]) v.writeBigUInt64LE(t, off);
  v.writeBigUInt64LE(sizes.alloc, 40);
  v.writeBigUInt64LE(sizes.real, 48);
  v.writeUInt32LE(attrs, 56);
  v[64] = name.length;
  v[65] = nameType;
  nb.copy(v, 66);
  return residentAttr(0x30, v);
}

export function dataResident(bytes: number): Buffer {
  return residentAttr(0x80, Buffer.alloc(bytes, 0x41));
}

export function attributeList(): Buffer {
  return residentAttr(0x20, Buffer.alloc(32));
}

/** Encode data runs (in clusters) the way NTFS does: relative signed LCN deltas, minimal byte counts. */
export function encodeRuns(runs: { clusters: number; lcn: number | null }[]): Buffer {
  const out: number[] = [];
  let prev = 0;
  const minBytesUnsigned = (n: number) => { let b = 1; while (n >= 2 ** (8 * b)) b++; return b; };
  const minBytesSigned = (n: number) => { let b = 1; while (n < -(2 ** (8 * b - 1)) || n >= 2 ** (8 * b - 1)) b++; return b; };
  for (const r of runs) {
    const lb = minBytesUnsigned(r.clusters);
    if (r.lcn === null) {
      out.push(lb, ...le(r.clusters, lb));
      continue;
    }
    const delta = r.lcn - prev;
    const ob = minBytesSigned(delta);
    out.push((ob << 4) | lb, ...le(r.clusters, lb), ...le(delta < 0 ? delta + 2 ** (8 * ob) : delta, ob));
    prev = r.lcn;
  }
  out.push(0);
  return Buffer.from(out);
}
function le(n: number, bytes: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < bytes; i++) { a.push(n % 256); n = Math.floor(n / 256); }
  return a;
}

// ---- record -----------------------------------------------------------------------------------
export const IN_USE = 0x01;
export const DIRECTORY = 0x02;

export function buildRecord(o: {
  attrs: Buffer[]; flags?: number; seq?: number; baseRecord?: number; usn?: number; size?: number; signature?: string;
}): Buffer {
  const size = o.size ?? RECORD_SIZE;
  const buf = Buffer.alloc(size);
  buf.write(o.signature ?? 'FILE', 0, 'ascii');
  const stripes = size / 512;
  buf.writeUInt16LE(0x30, 4); // update sequence array offset
  buf.writeUInt16LE(stripes + 1, 6);
  buf.writeUInt16LE(o.seq ?? 1, 0x10);
  buf.writeUInt16LE(1, 0x12);
  const first = align8(0x30 + (stripes + 1) * 2);
  buf.writeUInt16LE(first, 0x14);
  buf.writeUInt16LE(o.flags ?? IN_USE, 0x16);
  buf.writeUInt32LE(size, 0x1c);
  buf.writeBigUInt64LE(BigInt(o.baseRecord ?? 0), 0x20);

  let off = first;
  for (const a of o.attrs) { a.copy(buf, off); off += a.length; }
  buf.writeUInt32LE(0xffffffff, off);
  buf.writeUInt32LE(off + 8, 0x18); // used size

  // Encode update sequence: stash the real last 2 bytes of each stripe in the USA, put the USN there.
  const usn = o.usn ?? 0x0007;
  buf.writeUInt16LE(usn, 0x30);
  for (let i = 1; i <= stripes; i++) {
    const end = i * 512 - 2;
    buf[0x30 + 2 * i] = buf[end];
    buf[0x30 + 2 * i + 1] = buf[end + 1];
    buf.writeUInt16LE(usn, end);
  }
  return buf;
}

// ---- in-memory volume -------------------------------------------------------------------------
export class MemoryVolume implements VolumeReader {
  closed = false;
  reads = 0;
  constructor(public image: Buffer) {}
  read(offset: bigint, length: number): Buffer {
    this.reads++;
    return Buffer.from(this.image.subarray(Number(offset), Number(offset) + length)); // copy, like a real read
  }
  close(): void { this.closed = true; }
}

export function volumeData(over: Partial<NtfsVolumeData> = {}): NtfsVolumeData {
  return {
    volumeSerialNumber: 1n, numberSectors: 1000n, totalClusters: 1000n, freeClusters: 10n, totalReserved: 0n,
    bytesPerSector: 512, bytesPerCluster: CLUSTER, bytesPerFileRecordSegment: RECORD_SIZE,
    clustersPerFileRecordSegment: 0, mftValidDataLength: 0n, mftStartLcn: 0n, mft2StartLcn: 0n,
    mftZoneStart: 0n, mftZoneEnd: 0n, ...over,
  };
}
