// A generated volume with enough entries to exercise paging, type filters and hidden/system filters.
// The returned `entries` list is an independent oracle: tests compute expected results from it in plain JS.
import {
  CLUSTER, DIRECTORY, IN_USE, MemoryVolume, RECORD_SIZE, buildRecord, encodeRuns, fileNameAttr, nonResidentAttr,
  standardInfo, volumeData,
} from './builder';
import { MFTParser } from '../src/mft/parser';

export interface Entry {
  record: number;
  name: string;
  dir: string; // 'Media' | 'Docs'
  ext: string;
  size: number; // bytes
  mtime: Date;
  hidden: boolean;
  system: boolean;
}

export const DIR_RECORDS = { Media: 24, Docs: 25, HiddenDir: 26, SystemDir: 27 } as const;
const KINDS = [
  { prefix: 'video', ext: 'mp4', dir: 'Media' },
  { prefix: 'photo', ext: 'jpg', dir: 'Media' },
  { prefix: 'doc', ext: 'pdf', dir: 'Docs' },
  { prefix: 'song', ext: 'mp3', dir: 'Docs' },
  { prefix: 'weird', ext: 'xyz', dir: 'Docs' },
];
export const BASE_DATE = Date.UTC(2024, 0, 1);
const DAY = 86400000;

export function makeBigVolume(fileCount = 130) {
  const FIRST_FILE = 40;
  const totalRecords = FIRST_FILE + fileCount + 10;
  const mftClusters = Math.ceil((totalRecords * RECORD_SIZE) / CLUSTER);
  const MFT_LCN = 10;
  const image = Buffer.alloc((MFT_LCN + mftClusters + 10) * CLUSTER);
  const put = (n: number, rec: Buffer) => rec.copy(image, MFT_LCN * CLUSTER + n * RECORD_SIZE);
  const t = new Date(BASE_DATE);
  const si = (attrs = 0x20, m = t) => standardInfo({ c: m, m }, attrs);

  put(0, buildRecord({
    attrs: [
      si(0x6), fileNameAttr('$MFT', 5, 3, undefined, 0x6),
      nonResidentAttr(0x80, {
        lastVcn: BigInt(mftClusters - 1), runs: encodeRuns([{ clusters: mftClusters, lcn: MFT_LCN }]),
        alloc: BigInt(mftClusters * CLUSTER), real: BigInt(totalRecords * RECORD_SIZE),
      }),
    ],
  }));
  put(5, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x6), fileNameAttr('.', 5, 3)] }));
  put(DIR_RECORDS.Media, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Media', 5, 3)] }));
  put(DIR_RECORDS.Docs, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Docs', 5, 3)] }));
  put(DIR_RECORDS.HiddenDir, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x12), fileNameAttr('HiddenDir', 5, 3)] }));
  put(DIR_RECORDS.SystemDir, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x14), fileNameAttr('SystemDir', 5, 3)] }));

  const entries: Entry[] = [];
  for (let i = 0; i < fileCount; i++) {
    const kind = KINDS[i % KINDS.length];
    const hidden = i % 7 === 0;
    const system = i % 11 === 0;
    const size = (i + 1) * 1000; // all distinct -> a strict ordering by size
    const mtime = new Date(BASE_DATE + i * DAY);
    const name = `${kind.prefix}${String(i).padStart(3, '0')}.${kind.ext}`;
    const attrs = 0x20 | (hidden ? 0x2 : 0) | (system ? 0x4 : 0);
    const record = FIRST_FILE + i;
    put(record, buildRecord({
      attrs: [
        si(attrs, mtime),
        fileNameAttr(name, DIR_RECORDS[kind.dir as 'Media' | 'Docs'], 3),
        nonResidentAttr(0x80, {
          lastVcn: BigInt(Math.ceil(size / CLUSTER) - 1), alloc: BigInt(Math.ceil(size / CLUSTER) * CLUSTER), real: BigInt(size),
          runs: encodeRuns([{ clusters: Math.ceil(size / CLUSTER), lcn: 500 }]),
        }),
      ],
    }));
    entries.push({ record, name, dir: kind.dir, ext: kind.ext, size, mtime, hidden, system });
  }

  // $MFT itself is indexed too (hidden + system, lives in the root)
  entries.unshift({ record: 0, name: '$MFT', dir: 'root', ext: '', size: totalRecords * RECORD_SIZE, mtime: t, hidden: true, system: true });

  const mem = new MemoryVolume(image);
  const vol = volumeData({ mftStartLcn: BigInt(MFT_LCN), mftValidDataLength: BigInt(totalRecords * RECORD_SIZE) });
  return { mem, vol, entries, parser: () => new MFTParser(mem, vol) };
}

/** Sum of sizes of the entries visible under the given hidden/system filter. */
export function visible(entries: Entry[], includeHidden: boolean, includeSystem: boolean): Entry[] {
  return entries.filter((e) => (includeHidden || !e.hidden) && (includeSystem || !e.system));
}