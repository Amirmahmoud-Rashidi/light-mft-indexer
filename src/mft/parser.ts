// MFT Parser - Parses raw NTFS MFT records
import { MFTRecord, MFTAttribute, AttributeType, FileNameAttribute, StandardInformation, DataRun, FileAttributes, MFTRecordFlags, BootSector } from './types';
import { Win32API, openVolume, NTFS_VOLUME_DATA_BUFFER } from './win32';

export class MFTParser {
  private volumeHandle: number;
  private volumeData: NTFS_VOLUME_DATA_BUFFER;
  private bytesPerCluster: number;
  private bytesPerFileRecord: number;

  constructor(driveLetter: string) {
    this.volumeHandle = openVolume(driveLetter);
    this.volumeData = Win32API.getVolumeData(this.volumeHandle);
    this.bytesPerCluster = this.volumeData.BytesPerCluster;
    this.bytesPerFileRecord = this.volumeData.BytesPerFileRecordSegment;
  }

  close(): void {
    Win32API.closeHandle(this.volumeHandle);
  }

  getVolumeData(): NTFS_VOLUME_DATA_BUFFER {
    return this.volumeData;
  }

  readMFTRecord(recordNumber: number): MFTRecord | null {
    try {
      const buffer = Win32API.getFileRecord(this.volumeHandle, BigInt(recordNumber));
      return this.parseMFTRecord(buffer, recordNumber);
    } catch (error) {
      return null;
    }
  }

  private parseMFTRecord(buffer: Buffer, recordNumber: number): MFTRecord {
    // Parse MFT record header
    const signature = buffer.subarray(0, 4).toString('ascii');
    if (signature !== 'FILE') {
      throw new Error(`Invalid MFT record signature: ${signature}`);
    }

    const offset = buffer.readUInt16LE(4);
    const flags = buffer.readUInt16LE(6);
    const usedSize = buffer.readUInt32LE(8);
    const allocatedSize = buffer.readUInt32LE(12);
    const fileReference = buffer.readBigUInt64LE(16);
    const sequenceNumber = buffer.readUInt16LE(24);
    const linkCount = buffer.readUInt16LE(26);
    const attributeOffset = buffer.readUInt16LE(28);
    const flags2 = buffer.readUInt32LE(32);
    const recordNumber2 = buffer.readUInt32LE(36);

    const attributes: MFTAttribute[] = [];
    let attrOffset = attributeOffset;

    while (attrOffset < usedSize) {
      const attrType = buffer.readUInt32LE(attrOffset);
      if (attrType === 0xFFFFFFFF) break;

      const attrLength = buffer.readUInt32LE(attrOffset + 4);
      const nonResident = buffer.readUInt8(attrOffset + 8);
      const nameLength = buffer.readUInt8(attrOffset + 9);
      const nameOffset = buffer.readUInt16LE(attrOffset + 10);
      const flags = buffer.readUInt16LE(attrOffset + 12);
      const instance = buffer.readUInt16LE(attrOffset + 14);

      let content: any = {};
      let name = '';

      if (nameLength > 0) {
        name = buffer.subarray(attrOffset + nameOffset, attrOffset + nameOffset + nameLength * 2).toString('utf16le');
      }

      if (nonResident === 0) {
        // Resident attribute
        const valueLength = buffer.readUInt32LE(attrOffset + 16);
        const valueOffset = buffer.readUInt16LE(attrOffset + 20);
        const residentFlags = buffer.readUInt8(attrOffset + 22);
        
        content = {
          valueLength,
          valueOffset,
          residentFlags,
          value: buffer.subarray(attrOffset + valueOffset, attrOffset + valueOffset + valueLength),
        };
      } else {
        // Non-resident attribute
        const startVCN = buffer.readBigUInt64LE(attrOffset + 16);
        const lastVCN = buffer.readBigUInt64LE(attrOffset + 24);
        const dataRunsOffset = buffer.readUInt16LE(attrOffset + 32);
        const compressionUnit = buffer.readUInt8(attrOffset + 34);
        const allocatedSize = buffer.readBigUInt64LE(attrOffset + 40);
        const realSize = buffer.readBigUInt64LE(attrOffset + 48);
        const initializedSize = buffer.readBigUInt64LE(attrOffset + 56);

        const dataRuns = this.parseDataRuns(buffer, attrOffset + dataRunsOffset);
        
        content = {
          startVCN,
          lastVCN,
          dataRunsOffset,
          compressionUnit,
          allocatedSize,
          realSize,
          initializedSize,
          dataRuns,
        };
      }

      attributes.push({
        type: attrType as AttributeType,
        length: attrLength,
        nonResident: nonResident === 1,
        nameLength,
        nameOffset,
        flags,
        instance,
        content,
      });

      attrOffset += attrLength;
    }

    // Extract file info from attributes
    let fileName = '';
    let parentRecordNumber = 0;
    let creationTime = new Date();
    let modificationTime = new Date();
    let accessTime = new Date();
    let mftModificationTime = new Date();
    let fileSize = 0n;
    let allocatedFileSize = 0n;
    let fileAttributes = FileAttributes.NORMAL;

    for (const attr of attributes) {
      if (attr.type === AttributeType.FILE_NAME && attr.content.value) {
        const fnAttr = this.parseFileNameAttribute(attr.content.value);
        fileName = fnAttr.name;
        parentRecordNumber = Number(fnAttr.parentDirectory & 0xFFFFFFFFFFFFn);
        creationTime = fnAttr.creationTime;
        modificationTime = fnAttr.modificationTime;
        mftModificationTime = fnAttr.mftModificationTime;
        accessTime = fnAttr.accessTime;
        allocatedFileSize = fnAttr.allocatedSize;
        fileSize = fnAttr.realSize;
        fileAttributes = fnAttr.fileAttributes;
      } else if (attr.type === AttributeType.STANDARD_INFORMATION && attr.content.value) {
        const si = this.parseStandardInformation(attr.content.value);
        creationTime = si.creationTime;
        modificationTime = si.modificationTime;
        mftModificationTime = si.mftModificationTime;
        accessTime = si.accessTime;
        fileAttributes = si.fileAttributes;
      } else if (attr.type === AttributeType.DATA && !attr.nonResident && attr.content.value) {
        fileSize = BigInt(attr.content.valueLength || 0);
      } else if (attr.type === AttributeType.DATA && attr.nonResident) {
        fileSize = attr.content.realSize || 0n;
        allocatedFileSize = attr.content.allocatedSize || 0n;
      }
    }

    return {
      recordNumber,
      sequenceNumber,
      flags: flags as MFTRecordFlags,
      linkCount,
      attributeOffset,
      attributes,
      fileName,
      parentRecordNumber,
      creationTime,
      modificationTime,
      accessTime,
      mftModificationTime,
      allocatedSize: allocatedFileSize,
      realSize: fileSize,
      fileAttributes,
    };
  }

  private parseFileNameAttribute(buffer: Buffer): FileNameAttribute {
    const parentDirectory = buffer.readBigUInt64LE(0);
    const creationTime = this.fileTimeToDate(buffer.readBigUInt64LE(8));
    const modificationTime = this.fileTimeToDate(buffer.readBigUInt64LE(16));
    const mftModificationTime = this.fileTimeToDate(buffer.readBigUInt64LE(24));
    const accessTime = this.fileTimeToDate(buffer.readBigUInt64LE(32));
    const allocatedSize = buffer.readBigUInt64LE(40);
    const realSize = buffer.readBigUInt64LE(48);
    const fileAttributes = buffer.readUInt32LE(56);
    const nameLength = buffer.readUInt8(64);
    const nameType = buffer.readUInt8(65);
    const name = buffer.subarray(66, 66 + nameLength * 2).toString('utf16le');

    return {
      parentDirectory,
      creationTime,
      modificationTime,
      mftModificationTime,
      accessTime,
      allocatedSize,
      realSize,
      fileAttributes: fileAttributes as FileAttributes,
      nameLength,
      nameType,
      name,
    };
  }

  private parseStandardInformation(buffer: Buffer): StandardInformation {
    const creationTime = this.fileTimeToDate(buffer.readBigUInt64LE(0));
    const modificationTime = this.fileTimeToDate(buffer.readBigUInt64LE(8));
    const mftModificationTime = this.fileTimeToDate(buffer.readBigUInt64LE(16));
    const accessTime = this.fileTimeToDate(buffer.readBigUInt64LE(24));
    const fileAttributes = buffer.readUInt32LE(32);
    const maxVersions = buffer.readUInt32LE(36);
    const versionNumber = buffer.readUInt32LE(40);
    const classId = buffer.readUInt32LE(44);
    const ownerId = buffer.readUInt32LE(48);
    const securityId = buffer.readUInt32LE(52);
    const quotaCharged = buffer.readBigUInt64LE(56);
    const usn = buffer.readBigUInt64LE(64);

    return {
      creationTime,
      modificationTime,
      mftModificationTime,
      accessTime,
      fileAttributes: fileAttributes as FileAttributes,
      maxVersions,
      versionNumber,
      classId,
      ownerId,
      securityId,
      quotaCharged,
      usn,
    };
  }

  private parseDataRuns(buffer: Buffer, offset: number): DataRun[] {
    const runs: DataRun[] = [];
    let currentOffset = offset;
    let lastLCN = 0n;

    while (currentOffset < buffer.length) {
      const header = buffer.readUInt8(currentOffset);
      if (header === 0) break;

      const lengthBytes = header & 0x0F;
      const offsetBytes = (header >> 4) & 0x0F;

      currentOffset++;
      
      let length = 0n;
      for (let i = 0; i < lengthBytes; i++) {
        length |= BigInt(buffer.readUInt8(currentOffset + i)) << (8n * BigInt(i));
      }
      currentOffset += lengthBytes;

      let lcnOffset = 0n;
      for (let i = 0; i < offsetBytes; i++) {
        const byte = buffer.readUInt8(currentOffset + i);
        lcnOffset |= BigInt(byte) << (8n * BigInt(i));
      }
      currentOffset += offsetBytes;

      // Sign extend the offset
      if (offsetBytes > 0) {
        const signBit = 1n << (8n * BigInt(offsetBytes) - 1n);
        if (lcnOffset & signBit) {
          lcnOffset |= -1n << (8n * BigInt(offsetBytes));
        }
      }

      lastLCN += lcnOffset;
      
      runs.push({
        length: length * BigInt(this.bytesPerCluster),
        offset: lastLCN * BigInt(this.bytesPerCluster),
        isSparse: lcnOffset === -1n,
      });
    }

    return runs;
  }

  private fileTimeToDate(fileTime: bigint): Date {
    // Windows FILETIME is 100-nanosecond intervals since Jan 1, 1601
    // JavaScript Date is milliseconds since Jan 1, 1970
    const epochDiff = 116444736000000000n; // 100ns intervals between 1601 and 1970
    const ms = (fileTime - epochDiff) / 10000n;
    return new Date(Number(ms));
  }

  *enumerateRecords(startRecord: number = 0, maxRecords?: number): Generator<MFTRecord, void, unknown> {
    let count = 0;
    const max = maxRecords || Number(this.volumeData.MftValidDataLength / BigInt(this.bytesPerFileRecord));
    
    for (let i = startRecord; i < max; i++) {
      const record = this.readMFTRecord(i);
      if (record && (record.flags & MFTRecordFlags.IN_USE)) {
        yield record;
        count++;
      }
    }
  }
}

export function createMFTParser(driveLetter: string): MFTParser {
  return new MFTParser(driveLetter);
}