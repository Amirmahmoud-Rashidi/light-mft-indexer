// A small nested volume for exercising --only / --exclude end to end:
//   C:\ (5)
//     Projects (20)
//       app.js (30)
//       sub (21)
//         deep.txt (31)
//     node_modules (22)          <- name-pattern target
//       pkg.json (32)
//     Downloads (23)
//       node_modules (24)        <- same name, nested elsewhere: only the pattern catches both
//         inner.js (33)
//       report.pdf (34)
//     Cache.tmp (25, a FILE not a dir) plus a real .tmp file below
//     temp.tmp (35)              <- name-pattern (*.tmp) target
import {
  CLUSTER, DIRECTORY, IN_USE, MemoryVolume, RECORD_SIZE, buildRecord, dataResident, encodeRuns, fileNameAttr,
  nonResidentAttr, standardInfo, volumeData,
} from './builder';
import { MFTParser } from '../src/mft/parser';

const T = new Date('2024-06-01T00:00:00Z');
const si = (a = 0x20) => standardInfo({ c: T, m: T }, a);

export function makeScopeVolume() {
  const MFT_LCN = 10;
  const MFT_CLUSTERS = 16; // 16*4096/1024 = 64 record slots, plenty for record numbers up to 35
  const totalRecords = (MFT_CLUSTERS * CLUSTER) / RECORD_SIZE;
  const image = Buffer.alloc((MFT_LCN + MFT_CLUSTERS + 10) * CLUSTER);
  const at = MFT_LCN * CLUSTER;
  const put = (n: number, rec: Buffer) => rec.copy(image, at + n * RECORD_SIZE);

  put(0, buildRecord({
    attrs: [
      si(0x6), fileNameAttr('$MFT', 5, 3),
      nonResidentAttr(0x80, {
        lastVcn: BigInt(MFT_CLUSTERS - 1), runs: encodeRuns([{ clusters: MFT_CLUSTERS, lcn: MFT_LCN }]),
        alloc: BigInt(MFT_CLUSTERS * CLUSTER), real: BigInt(totalRecords * RECORD_SIZE),
      }),
    ],
  }));
  put(5, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x6), fileNameAttr('.', 5, 3)] }));
  put(20, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Projects', 5, 3)] }));
  put(21, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('sub', 20, 3)] }));
  put(22, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('node_modules', 5, 3)] }));
  put(23, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('Downloads', 5, 3)] }));
  put(24, buildRecord({ flags: IN_USE | DIRECTORY, attrs: [si(0x10), fileNameAttr('node_modules', 23, 3)] }));

  put(30, buildRecord({ attrs: [si(), fileNameAttr('app.js', 20, 3), dataResident(10)] }));
  put(31, buildRecord({ attrs: [si(), fileNameAttr('deep.txt', 21, 3), dataResident(20)] }));
  put(32, buildRecord({ attrs: [si(), fileNameAttr('pkg.json', 22, 3), dataResident(30)] }));
  put(33, buildRecord({ attrs: [si(), fileNameAttr('inner.js', 24, 3), dataResident(40)] }));
  put(34, buildRecord({ attrs: [si(), fileNameAttr('report.pdf', 23, 3), dataResident(50)] }));
  put(35, buildRecord({ attrs: [si(), fileNameAttr('temp.tmp', 5, 3), dataResident(60)] }));

  const mem = new MemoryVolume(image);
  const vol = volumeData({ mftStartLcn: BigInt(MFT_LCN), mftValidDataLength: BigInt(totalRecords * RECORD_SIZE) });
  return { mem, parser: () => new MFTParser(mem, vol) };
}

/** All 6 file names for reference in tests. */
export const ALL_FILES = ['app.js', 'deep.txt', 'pkg.json', 'inner.js', 'report.pdf', 'temp.tmp', '$MFT'];