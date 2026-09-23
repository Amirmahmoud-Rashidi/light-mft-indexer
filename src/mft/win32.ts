// Win32 API bindings for raw disk access and MFT reading
import { ref, ffi, Struct, ArrayType, Pointer } from 'ref-napi';
import { win32Api } from './win32-api';

// Windows API constants
export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const FILE_SHARE_READ = 0x00000001;
export const FILE_SHARE_WRITE = 0x00000002;
export const OPEN_EXISTING = 3;
export const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
export const FILE_FLAG_NO_BUFFERING = 0x20000000;
export const FILE_FLAG_OVERLAPPED = 0x40000000;
export const INVALID_HANDLE_VALUE = -1;

export const FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064;
export const FSCTL_GET_NTFS_FILE_RECORD = 0x00090074;
export const FSCTL_ENUM_USN_DATA = 0x000900B3;
export const FSCTL_READ_USN_JOURNAL = 0x000900BB;
export const FSCTL_CREATE_USN_JOURNAL = 0x00090057;
export const FSCTL_QUERY_USN_JOURNAL = 0x0009005F;
export const FSCTL_DELETE_USN_JOURNAL = 0x0009005B;

export const IOCTL_DISK_GET_DRIVE_GEOMETRY = 0x00070000;
export const IOCTL_DISK_GET_PARTITION_INFO = 0x00074004;
export const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS = 0x00560000;

// NTFS structures
export class NTFS_VOLUME_DATA_BUFFER extends Struct {
  constructor() {
    super();
    this.VolumeSerialNumber = BigInt(0);
    this.NumberSectors = BigInt(0);
    this.TotalClusters = BigInt(0);
    this.FreeClusters = BigInt(0);
    this.TotalReserved = BigInt(0);
    this.BytesPerSector = 0;
    this.BytesPerCluster = 0;
    this.BytesPerFileRecordSegment = 0;
    this.ClustersPerFileRecordSegment = 0;
    this.MftValidDataLength = BigInt(0);
    this.MftStartLcn = BigInt(0);
    this.Mft2StartLcn = BigInt(0);
    this.MftZoneStart = BigInt(0);
    this.MftZoneEnd = BigInt(0);
  }
}

export class NTFS_FILE_RECORD_INPUT_BUFFER extends Struct {
  constructor() {
    super();
    this.FileReferenceNumber = BigInt(0);
  }
}

export class NTFS_FILE_RECORD_OUTPUT_BUFFER extends Struct {
  constructor() {
    super();
    this.FileReferenceNumber = BigInt(0);
    this.FileRecordLength = 0;
    this.FileRecordBuffer = Buffer.alloc(1);
  }
}

// Win32 API function signatures
const kernel32 = ffi.Library('kernel32', {
  CreateFileW: ['int', ['string', 'int', 'int', 'pointer', 'int', 'int', 'int']],
  CloseHandle: ['bool', ['int']],
  ReadFile: ['bool', ['int', 'pointer', 'int', 'pointer', 'pointer']],
  WriteFile: ['bool', ['int', 'pointer', 'int', 'pointer', 'pointer']],
  SetFilePointerEx: ['bool', ['int', 'int64', 'pointer', 'int']],
  GetFileSizeEx: ['bool', ['int', 'pointer']],
  DeviceIoControl: ['bool', ['int', 'int', 'pointer', 'int', 'pointer', 'int', 'pointer', 'pointer']],
  GetLastError: ['int', []],
  GetLogicalDrives: ['int', []],
  GetDriveTypeW: ['int', ['string']],
  GetDiskFreeSpaceExW: ['bool', ['string', 'pointer', 'pointer', 'pointer']],
  QueryDosDeviceW: ['int', ['string', 'string', 'int']],
});

const ntdll = ffi.Library('ntdll', {
  NtCreateFile: ['int', ['pointer', 'int', 'pointer', 'pointer', 'pointer', 'int', 'int', 'int', 'int', 'pointer', 'int']],
  NtReadFile: ['int', ['int', 'int', 'pointer', 'pointer', 'pointer', 'pointer', 'int64', 'pointer', 'pointer']],
  NtQueryInformationFile: ['int', ['int', 'pointer', 'pointer', 'int', 'int']],
  NtFsControlFile: ['int', ['int', 'int', 'pointer', 'pointer', 'pointer', 'int', 'pointer', 'int', 'pointer', 'int']],
  RtlInitUnicodeString: ['void', ['pointer', 'string']],
  RtlDosPathNameToNtPathName_U: ['bool', ['string', 'pointer', 'pointer', 'pointer']],
});

export class Win32API {
  static createFile(path: string, desiredAccess: number, shareMode: number, creationDisposition: number, flagsAndAttributes: number): number {
    const handle = kernel32.CreateFileW(path, desiredAccess, shareMode, ref.NULL, creationDisposition, flagsAndAttributes, 0);
    if (handle === INVALID_HANDLE_VALUE) {
      throw new Error(`CreateFile failed: ${kernel32.GetLastError()}`);
    }
    return handle;
  }

  static closeHandle(handle: number): void {
    if (!kernel32.CloseHandle(handle)) {
      throw new Error(`CloseHandle failed: ${kernel32.GetLastError()}`);
    }
  }

  static deviceIoControl(handle: number, ioControlCode: number, inBuffer: Buffer, outBuffer: Buffer): number {
    const bytesReturned = ref.alloc('int');
    const result = kernel32.DeviceIoControl(handle, ioControlCode, inBuffer, inBuffer.length, outBuffer, outBuffer.length, bytesReturned, ref.NULL);
    if (!result) {
      throw new Error(`DeviceIoControl failed: ${kernel32.GetLastError()}`);
    }
    return bytesReturned.deref();
  }

  static getLogicalDrives(): string[] {
    const drives = kernel32.GetLogicalDrives();
    const result: string[] = [];
    for (let i = 0; i < 26; i++) {
      if (drives & (1 << i)) {
        result.push(String.fromCharCode(65 + i) + ':');
      }
    }
    return result;
  }

  static getDriveType(drive: string): number {
    return kernel32.GetDriveTypeW(drive + '\\');
  }

  static getDiskFreeSpace(drive: string): { freeBytes: bigint; totalBytes: bigint; totalFreeBytes: bigint } {
    const freeBytes = ref.alloc('int64');
    const totalBytes = ref.alloc('int64');
    const totalFreeBytes = ref.alloc('int64');
    
    if (!kernel32.GetDiskFreeSpaceExW(drive + '\\', freeBytes, totalBytes, totalFreeBytes)) {
      throw new Error(`GetDiskFreeSpaceEx failed: ${kernel32.GetLastError()}`);
    }
    
    return {
      freeBytes: BigInt(freeBytes.deref()),
      totalBytes: BigInt(totalBytes.deref()),
      totalFreeBytes: BigInt(totalFreeBytes.deref()),
    };
  }

  static getVolumeData(handle: number): NTFS_VOLUME_DATA_BUFFER {
    const outBuffer = Buffer.alloc(1024);
    this.deviceIoControl(handle, FSCTL_GET_NTFS_VOLUME_DATA, Buffer.alloc(0), outBuffer);
    return new NTFS_VOLUME_DATA_BUFFER(outBuffer);
  }

  static getFileRecord(handle: number, fileReferenceNumber: bigint): Buffer {
    const inBuffer = Buffer.alloc(8);
    inBuffer.writeBigUInt64LE(fileReferenceNumber, 0);
    const outBuffer = Buffer.alloc(65536); // Max MFT record size
    const bytesReturned = this.deviceIoControl(handle, FSCTL_GET_NTFS_FILE_RECORD, inBuffer, outBuffer);
    return outBuffer.subarray(0, bytesReturned);
  }
}

export function openVolume(driveLetter: string): number {
  const path = `\\\\.\\${driveLetter}:`;
  return Win32API.createFile(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
}

export function getVolumeHandle(driveLetter: string): number {
  return openVolume(driveLetter);
}