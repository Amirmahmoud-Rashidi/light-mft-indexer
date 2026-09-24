// Win32 bindings (via koffi) for raw NTFS volume access.
//
// koffi ships prebuilt binaries (no Visual Studio / node-gyp needed) and is loaded lazily, so this
// module can be imported on any OS; only actually calling into Windows requires win32.
import { NtfsVolumeData, VolumeReader } from './types';
import { normalizeDriveLetter } from './drive';

// ---- Windows API constants -------------------------------------------------------------------
export const GENERIC_READ = 0x80000000;
export const FILE_SHARE_READ = 0x00000001;
export const FILE_SHARE_WRITE = 0x00000002;
export const OPEN_EXISTING = 3;
export const FILE_BEGIN = 0;
export const INVALID_HANDLE_VALUE = -1;

// CTL_CODE(FILE_DEVICE_FILE_SYSTEM = 9, function, method, FILE_ANY_ACCESS)
export const FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064; // function 25, buffered
export const FSCTL_GET_NTFS_FILE_RECORD = 0x00090068; // function 26, buffered
export const FSCTL_ENUM_USN_DATA = 0x000900b3; // function 44, neither
export const FSCTL_READ_USN_JOURNAL = 0x000900bb; // function 46, neither
export const FSCTL_CREATE_USN_JOURNAL = 0x000900e7; // function 57, neither
export const FSCTL_QUERY_USN_JOURNAL = 0x000900f4; // function 61, buffered
export const FSCTL_DELETE_USN_JOURNAL = 0x000900f8; // function 62, buffered

const ERROR_HINTS: Record<number, string> = {
  1: 'The volume is not NTFS (MFT access only works on NTFS).',
  2: 'The drive does not exist.',
  3: 'The drive does not exist.',
  5: 'Access denied. Raw volume access needs Administrator rights: start the terminal / MCP host "as administrator".',
  32: 'The volume is locked by another program.',
  87: 'Invalid parameter.',
};

export class Win32Error extends Error {
  constructor(
    public readonly fn: string,
    public readonly code: number
  ) {
    super(`${fn} failed (Win32 error ${code})${ERROR_HINTS[code] ? ': ' + ERROR_HINTS[code] : ''}`);
    this.name = 'Win32Error';
  }
}

// ---- Lazy koffi bindings ---------------------------------------------------------------------
type Fn = (...args: any[]) => any;
interface Native {
  CreateFileW: Fn;
  CloseHandle: Fn;
  ReadFile: Fn;
  SetFilePointerEx: Fn;
  DeviceIoControl: Fn;
  GetLastError: Fn;
  GetLogicalDrives: Fn;
  GetDriveTypeW: Fn;
  GetDiskFreeSpaceExW: Fn;
}

let native: Native | undefined;

function getNative(): Native {
  if (native) return native;
  if (process.platform !== 'win32') {
    throw new Error('mft-indexer needs Windows (NTFS + Win32 API); current platform: ' + process.platform);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi: typeof import('koffi') = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  // HANDLE is declared as intptr_t so it comes back as a plain JS number (INVALID_HANDLE_VALUE === -1).
  // All output parameters are `void *` backed by Node Buffers, which koffi passes by reference.
  native = {
    CreateFileW: k32.func('CreateFileW', 'intptr_t', [
      'str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'intptr_t',
    ]),
    CloseHandle: k32.func('CloseHandle', 'int32_t', ['intptr_t']),
    ReadFile: k32.func('ReadFile', 'int32_t', ['intptr_t', 'void *', 'uint32_t', 'void *', 'void *']),
    SetFilePointerEx: k32.func('SetFilePointerEx', 'int32_t', ['intptr_t', 'int64_t', 'void *', 'uint32_t']),
    DeviceIoControl: k32.func('DeviceIoControl', 'int32_t', [
      'intptr_t', 'uint32_t', 'void *', 'uint32_t', 'void *', 'uint32_t', 'void *', 'void *',
    ]),
    GetLastError: k32.func('GetLastError', 'uint32_t', []),
    GetLogicalDrives: k32.func('GetLogicalDrives', 'uint32_t', []),
    GetDriveTypeW: k32.func('GetDriveTypeW', 'uint32_t', ['str16']),
    GetDiskFreeSpaceExW: k32.func('GetDiskFreeSpaceExW', 'int32_t', ['str16', 'void *', 'void *', 'void *']),
  };
  return native;
}

// ---- Thin wrappers ---------------------------------------------------------------------------
export class Win32API {
  static createFile(
    filePath: string,
    desiredAccess: number,
    shareMode: number,
    creationDisposition: number,
    flagsAndAttributes = 0
  ): number {
    const n = getNative();
    const handle: number = n.CreateFileW(filePath, desiredAccess, shareMode, null, creationDisposition, flagsAndAttributes, 0);
    if (handle === INVALID_HANDLE_VALUE) throw new Win32Error('CreateFileW', n.GetLastError());
    return handle;
  }

  static closeHandle(handle: number): void {
    const n = getNative();
    if (!n.CloseHandle(handle)) throw new Win32Error('CloseHandle', n.GetLastError());
  }

  /** Returns the number of bytes written to outBuffer. */
  static deviceIoControl(handle: number, ioControlCode: number, inBuffer: Buffer | null, outBuffer: Buffer): number {
    const n = getNative();
    const returned = Buffer.alloc(4);
    const ok = n.DeviceIoControl(
      handle, ioControlCode,
      inBuffer, inBuffer ? inBuffer.length : 0,
      outBuffer, outBuffer.length,
      returned, null
    );
    if (!ok) throw new Win32Error('DeviceIoControl', n.GetLastError());
    return returned.readUInt32LE(0);
  }

  static setFilePointer(handle: number, offset: bigint): void {
    const n = getNative();
    if (!n.SetFilePointerEx(handle, offset, null, FILE_BEGIN)) throw new Win32Error('SetFilePointerEx', n.GetLastError());
  }

  /** Reads up to buffer.length bytes at the current position; returns the number of bytes read. */
  static readFile(handle: number, buffer: Buffer): number {
    const n = getNative();
    const read = Buffer.alloc(4);
    if (!n.ReadFile(handle, buffer, buffer.length, read, null)) throw new Win32Error('ReadFile', n.GetLastError());
    return read.readUInt32LE(0);
  }

  static getLogicalDrives(): string[] {
    const mask: number = getNative().GetLogicalDrives();
    const result: string[] = [];
    for (let i = 0; i < 26; i++) {
      if (mask & (1 << i)) result.push(String.fromCharCode(65 + i) + ':');
    }
    return result;
  }

  static getDriveType(drive: string): number {
    return getNative().GetDriveTypeW(drive.replace(/[\\/]+$/, '') + '\\');
  }

  static getDiskFreeSpace(drive: string): { freeBytes: bigint; totalBytes: bigint; totalFreeBytes: bigint } {
    const n = getNative();
    const free = Buffer.alloc(8);
    const total = Buffer.alloc(8);
    const totalFree = Buffer.alloc(8);
    if (!n.GetDiskFreeSpaceExW(drive.replace(/[\\/]+$/, '') + '\\', free, total, totalFree)) {
      throw new Win32Error('GetDiskFreeSpaceExW', n.GetLastError());
    }
    return {
      freeBytes: free.readBigUInt64LE(0),
      totalBytes: total.readBigUInt64LE(0),
      totalFreeBytes: totalFree.readBigUInt64LE(0),
    };
  }
}

// ---- NTFS_VOLUME_DATA_BUFFER -----------------------------------------------------------------
export const NTFS_VOLUME_DATA_SIZE = 96;

/** Decode the fixed 96-byte NTFS_VOLUME_DATA_BUFFER header (an extended part may follow; ignored). */
export function parseVolumeData(buf: Buffer): NtfsVolumeData {
  if (buf.length < NTFS_VOLUME_DATA_SIZE) {
    throw new Error(`NTFS_VOLUME_DATA_BUFFER too short: ${buf.length} bytes`);
  }
  return {
    volumeSerialNumber: buf.readBigUInt64LE(0),
    numberSectors: buf.readBigUInt64LE(8),
    totalClusters: buf.readBigUInt64LE(16),
    freeClusters: buf.readBigUInt64LE(24),
    totalReserved: buf.readBigUInt64LE(32),
    bytesPerSector: buf.readUInt32LE(40),
    bytesPerCluster: buf.readUInt32LE(44),
    bytesPerFileRecordSegment: buf.readUInt32LE(48),
    clustersPerFileRecordSegment: buf.readUInt32LE(52),
    mftValidDataLength: buf.readBigUInt64LE(56),
    mftStartLcn: buf.readBigUInt64LE(64),
    mft2StartLcn: buf.readBigUInt64LE(72),
    mftZoneStart: buf.readBigUInt64LE(80),
    mftZoneEnd: buf.readBigUInt64LE(88),
  };
}

// ---- Volume ----------------------------------------------------------------------------------
const MAX_READ = 64 * 1024 * 1024; // stay far below the 4 GiB ReadFile limit

/** An open raw NTFS volume (\\.\C:). Implements sector-aligned reads on top of ReadFile. */
export class Volume implements VolumeReader {
  readonly volumeData: NtfsVolumeData;
  private handle: number;
  private closed = false;
  private readonly sector: number;

  constructor(driveLetter: string) {
    const letter = normalizeDriveLetter(driveLetter);
    this.handle = Win32API.createFile(`\\\\.\\${letter}:`, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING);
    try {
      const out = Buffer.alloc(128);
      Win32API.deviceIoControl(this.handle, FSCTL_GET_NTFS_VOLUME_DATA, null, out);
      this.volumeData = parseVolumeData(out);
    } catch (e) {
      Win32API.closeHandle(this.handle);
      this.closed = true;
      throw e;
    }
    this.sector = Math.max(this.volumeData.bytesPerSector, 512);
  }

  read(offset: bigint, length: number): Buffer {
    if (this.closed) throw new Error('Volume is closed');
    if (length <= 0) return Buffer.alloc(0);
    const sector = BigInt(this.sector);
    const alignedStart = offset - (offset % sector);
    const lead = Number(offset - alignedStart);
    const alignedLength = Math.ceil((lead + length) / this.sector) * this.sector;

    const out = Buffer.alloc(alignedLength);
    let done = 0;
    Win32API.setFilePointer(this.handle, alignedStart);
    while (done < alignedLength) {
      const chunk = out.subarray(done, Math.min(alignedLength, done + MAX_READ));
      const got = Win32API.readFile(this.handle, chunk);
      if (got === 0) throw new Error(`Unexpected end of volume at offset ${alignedStart + BigInt(done)}`);
      done += got;
    }
    return out.subarray(lead, lead + length);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    Win32API.closeHandle(this.handle);
  }
}

export function openVolume(driveLetter: string): Volume {
  return new Volume(driveLetter);
}
