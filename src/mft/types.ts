// MFT Types and Interfaces
// Core types for NTFS Master File Table parsing

export interface MFTRecord {
  recordNumber: number;
  sequenceNumber: number;
  flags: MFTRecordFlags;
  linkCount: number;
  attributeOffset: number;
  attributes: MFTAttribute[];
  fileName: string;
  parentRecordNumber: number;
  creationTime: Date;
  modificationTime: Date;
  accessTime: Date;
  mftModificationTime: Date;
  allocatedSize: number;
  realSize: number;
  fileAttributes: FileAttributes;
}

export enum MFTRecordFlags {
  IN_USE = 0x01,
  DIRECTORY = 0x02,
  EXTENDED = 0x04,
  VIEW_INDEX = 0x08,
}

export enum FileAttributes {
  READONLY = 0x00000001,
  HIDDEN = 0x00000002,
  SYSTEM = 0x00000004,
  ARCHIVE = 0x00000020,
  DEVICE = 0x00000040,
  NORMAL = 0x00000080,
  TEMPORARY = 0x00000100,
  SPARSE_FILE = 0x00000200,
  REPARSE_POINT = 0x00000400,
  COMPRESSED = 0x00000800,
  OFFLINE = 0x00001000,
  NOT_CONTENT_INDEXED = 0x00002000,
  ENCRYPTED = 0x00004000,
  INTEGRITY_STREAM = 0x00008000,
  VIRTUAL = 0x00010000,
  NO_SCRUB_DATA = 0x00020000,
  RECALL_ON_OPEN = 0x00040000,
  PINNED = 0x00080000,
  UNPINNED = 0x00100000,
  DIRECTORY = 0x10000000,
}

export interface MFTAttribute {
  type: AttributeType;
  length: number;
  nonResident: boolean;
  nameLength: number;
  nameOffset: number;
  flags: number;
  instance: number;
  content: AttributeContent;
}

export enum AttributeType {
  STANDARD_INFORMATION = 0x10,
  ATTRIBUTE_LIST = 0x20,
  FILE_NAME = 0x30,
  OBJECT_ID = 0x40,
  SECURITY_DESCRIPTOR = 0x50,
  VOLUME_NAME = 0x60,
  VOLUME_INFORMATION = 0x70,
  DATA = 0x80,
  INDEX_ROOT = 0x90,
  INDEX_ALLOCATION = 0xA0,
  BITMAP = 0xB0,
  REPARSE_POINT = 0xC0,
  EA_INFORMATION = 0xD0,
  EA = 0xE0,
  LOGGED_UTILITY_STREAM = 0x100,
}

export interface AttributeContent {
  // Resident attribute
  valueLength?: number;
  valueOffset?: number;
  residentFlags?: number;
  
  // Non-resident attribute
  startVCN?: bigint;
  lastVCN?: bigint;
  dataRunsOffset?: number;
  compressionUnit?: number;
  allocatedSize?: bigint;
  realSize?: bigint;
  initializedSize?: bigint;
  dataRuns?: DataRun[];
}

export interface DataRun {
  length: bigint;
  offset: bigint;
  isSparse: boolean;
}

export interface StandardInformation {
  creationTime: Date;
  modificationTime: Date;
  mftModificationTime: Date;
  accessTime: Date;
  fileAttributes: FileAttributes;
  maxVersions: number;
  versionNumber: number;
  classId: number;
  ownerId: number;
  securityId: number;
  quotaCharged: bigint;
  usn: bigint;
}

export interface FileNameAttribute {
  parentDirectory: bigint;
  creationTime: Date;
  modificationTime: Date;
  mftModificationTime: Date;
  accessTime: Date;
  allocatedSize: bigint;
  realSize: bigint;
  fileAttributes: FileAttributes;
  nameLength: number;
  nameType: number;
  name: string;
}

export interface VolumeInformation {
  majorVersion: number;
  minorVersion: number;
  flags: number;
  unused: number;
}

export interface BootSector {
  jumpInstruction: Buffer;
  oemId: string;
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectors: number;
  mediaDescriptor: number;
  sectorsPerTrack: number;
  heads: number;
  hiddenSectors: number;
  totalSectors: bigint;
  mftClusterNumber: bigint;
  mftMirrorClusterNumber: bigint;
  clustersPerMFTRecord: number;
  clustersPerIndexBuffer: number;
  volumeSerialNumber: bigint;
  checksum: number;
}

export interface IndexOptions {
  driveLetter: string;
  includeHidden?: boolean;
  includeSystem?: boolean;
  maxDepth?: number;
  followJunctions?: boolean;
  batchSize?: number;
}

export interface IndexStats {
  totalFiles: number;
  totalDirectories: number;
  totalSize: bigint;
  indexedAt: Date;
  duration: number;
  driveLetter: string;
}

export interface DiskUsage {
  driveLetter: string;
  totalSpace: bigint;
  freeSpace: bigint;
  usedSpace: bigint;
  usagePercent: number;
  fileCount: number;
  directoryCount: number;
  largestFiles: FileInfo[];
  largestDirectories: DirectoryInfo[];
}

export interface FileInfo {
  path: string;
  size: bigint;
  modifiedTime: Date;
  attributes: FileAttributes;
}

export interface DirectoryInfo {
  path: string;
  size: bigint;
  fileCount: number;
  subdirectoryCount: number;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
}

export interface SearchFilters {
  minSize?: bigint;
  maxSize?: bigint;
  modifiedAfter?: Date;
  modifiedBefore?: Date;
  fileTypes?: string[];
  directories?: string[];
  attributes?: FileAttributes[];
}

export interface SearchResult {
  files: MFTRecord[];
  totalMatches: number;
  searchTime: number;
}