import { getDataDir, getIndexDbPath, normalizeDriveLetter } from '../src/mft/drive';
import { NTFS_VOLUME_DATA_SIZE, Win32API, Win32Error, parseVolumeData } from '../src/mft/win32';

describe('normalizeDriveLetter', () => {
  it.each([['c', 'C'], ['C:', 'C'], ['d:\\', 'D'], [' e: ', 'E'], ['F:/', 'F']])('accepts %s', (input, expected) => {
    expect(normalizeDriveLetter(input)).toBe(expected);
  });
  it.each(['', 'CC', '1', 'C:\\Windows', '\\\\.\\C:', '..', 'C:\\..\\x', 'C;'])('rejects %j', (input) => {
    expect(() => normalizeDriveLetter(input)).toThrow(/Invalid drive letter/);
  });
});

describe('parseVolumeData', () => {
  it('decodes the NTFS_VOLUME_DATA_BUFFER layout', () => {
    const b = Buffer.alloc(128);
    b.writeBigUInt64LE(0x1234567890abcdefn, 0);
    b.writeBigUInt64LE(1000n, 8);
    b.writeBigUInt64LE(125n, 16);
    b.writeBigUInt64LE(50n, 24);
    b.writeBigUInt64LE(7n, 32);
    b.writeUInt32LE(512, 40);
    b.writeUInt32LE(4096, 44);
    b.writeUInt32LE(1024, 48);
    b.writeUInt32LE(0, 52);
    b.writeBigUInt64LE(300_000_000n, 56);
    b.writeBigUInt64LE(786432n, 64);
    b.writeBigUInt64LE(2n, 72);
    b.writeBigUInt64LE(100n, 80);
    b.writeBigUInt64LE(200n, 88);
    const v = parseVolumeData(b);
    expect(v).toMatchObject({
      volumeSerialNumber: 0x1234567890abcdefn, numberSectors: 1000n, totalClusters: 125n, freeClusters: 50n,
      totalReserved: 7n, bytesPerSector: 512, bytesPerCluster: 4096, bytesPerFileRecordSegment: 1024,
      mftValidDataLength: 300_000_000n, mftStartLcn: 786432n, mft2StartLcn: 2n, mftZoneStart: 100n, mftZoneEnd: 200n,
    });
  });
  it('rejects a short buffer', () => {
    expect(() => parseVolumeData(Buffer.alloc(NTFS_VOLUME_DATA_SIZE - 1))).toThrow(/too short/);
  });
});

describe('native layer off Windows', () => {
  it('is loadable everywhere and fails with a clear message only when used', () => {
    if (process.platform === 'win32') return;
    expect(() => Win32API.getLogicalDrives()).toThrow(/needs Windows/);
  });
  it('Win32Error explains the common failure (access denied)', () => {
    expect(new Win32Error('CreateFileW', 5).message).toMatch(/Administrator/);
    expect(new Win32Error('DeviceIoControl', 1).message).toMatch(/not NTFS/);
  });
});

describe('data dir', () => {
  it('honours MFT_INDEXER_DATA_DIR and never depends on cwd', () => {
    const dir = require('os').tmpdir() + '/mft-indexer-test-' + process.pid;
    process.env.MFT_INDEXER_DATA_DIR = dir;
    expect(getDataDir()).toBe(dir);
    expect(getIndexDbPath('c')).toBe(require('path').join(dir, 'mft-index-C.db'));
    delete process.env.MFT_INDEXER_DATA_DIR;
  });
});
