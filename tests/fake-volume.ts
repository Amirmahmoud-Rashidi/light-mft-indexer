// A small but nasty synthetic NTFS volume: fragmented $MFT, extension record, DOS+Win32 names,
// records that straddle the 512-byte fixup boundary, torn / free / garbage records, orphans.
import {
  CLUSTER, DIRECTORY, IN_USE, MemoryVolume, RECORD_SIZE, attributeList, buildRecord, dataResident,
  encodeRuns, fileNameAttr, nonResidentAttr, standardInfo, volumeData,
} from './builder';
import { MFTParser } from '../src/mft/parser';

export const LONG_NAME = Array.from({ length: 194 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
export const T_CREATE = new Date('2024-01-02T03:04:05.678Z');
export const T_MODIFY = new Date('2024-02-03T04:05:06.000Z');

const FRAG_A = { lcn: 10, clusters: 8 };  // records 0..31
const FRAG_B = { lcn: 100, clusters: 12 }; // records 32..79
export const TOTAL_RECORDS = 80;

const at = (n: number) => (n < 32 ? FRAG_A.lcn * CLUSTER + n * RECORD_SIZE : FRAG_B.lcn * CLUSTER + (n - 32) * RECORD_SIZE);
const si = (attrs = 0x20) => standardInfo({ c: T_CREATE, m: T_MODIFY }, attrs);

export function makeFakeVolume() {
  const image = Buffer.alloc(200 * CLUSTER);
  const put = (n: number, rec: Buffer) => rec.copy(image, at(n));

  const totalClusters = FRAG_A.clusters + FRAG_B.clusters;
  put(0, buildRecord({
    attrs: [
      si(0x6),
      fileNameAttr('$MFT', 5, 3, { alloc: 0n, real: 0n }, 0x6),
      nonResidentAttr(0x80, {
        lastVcn: BigInt(totalClusters - 1),
        runs: encodeRuns([{ clusters: FRAG_A.clusters, lcn: FRAG_A.lcn }, { clusters: FRAG_B.clusters, lcn: FRAG_B.lcn }]),
        alloc: BigInt(totalClusters * CLUSTER), real: BigInt(totalClusters * CLUSTER),
      }),
    ],
  }));
  put(5, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x6), fileNameAttr('.', 5, 3)] }));
  put(24, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Users', 5, 3)] }));
  put(30, buildRecord({ attrs: [si(), fileNameAttr('readme.txt', 24, 3), dataResident(11)] }));
  // big.bin: $DATA lives in extension record 50; the cached size in $FILE_NAME is stale (0)
  put(31, buildRecord({ attrs: [si(), fileNameAttr('big.bin', 24, 3), attributeList()] }));
  put(32, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Docs', 24, 3)] })); // first record of fragment B
  put(33, buildRecord({ attrs: [si(), fileNameAttr('a.txt', 32, 3), dataResident(100)] }));
  put(40, buildRecord({ attrs: [si(), fileNameAttr(LONG_NAME + '.txt', 32, 1), dataResident(5)] })); // name crosses byte 510
  put(50, buildRecord({
    baseRecord: 31,
    attrs: [nonResidentAttr(0x80, { startVcn: 0n, lastVcn: 1220n, alloc: 5_001_216n, real: 5_000_000n, runs: encodeRuns([{ clusters: 1221, lcn: 500 }]) })],
  }));
  put(61, buildRecord({ attrs: [si(), fileNameAttr('LONGFI~1.TXT', 24, 2), fileNameAttr('long file name.txt', 24, 1), dataResident(3)] }));
  put(62, buildRecord({ attrs: [si(0x22), fileNameAttr('hidden.dat', 24, 3), dataResident(7)] }));
  put(63, buildRecord({ attrs: [si(), fileNameAttr('orphan.txt', 999, 3), dataResident(4)] }));
  put(64, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Lost', 998, 3)] }));
  put(65, buildRecord({ attrs: [si(), fileNameAttr('inlost.txt', 64, 3), dataResident(9)] }));
  put(70, buildRecord({ flags: 0, attrs: [si(), fileNameAttr('deleted.txt', 24, 3), dataResident(1)] })); // free
  const torn = buildRecord({ attrs: [si(), fileNameAttr('torn.txt', 24, 3), dataResident(1)] });
  torn.writeUInt16LE(0x1234, 510); // stripe no longer carries the update sequence number -> torn write
  put(71, torn);
  put(72, buildRecord({ signature: 'BAAD', attrs: [] }));

  const mem = new MemoryVolume(image);
  const vol = volumeData({ mftStartLcn: BigInt(FRAG_A.lcn), mftValidDataLength: BigInt(TOTAL_RECORDS * RECORD_SIZE) });
  return { mem, vol, parser: () => new MFTParser(mem, vol) };
}
