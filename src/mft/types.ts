// MFT Types and Interfaces
// Core types for NTFS Master File Table parsing

export interface MFTRecord {
  recordNumber: number;
  sequenceNumber: number;
  flags: MFTRecordFlags;
  linkCount: number;
  attributeOffset: number;
  /** Raw attribute list. Not populated by the parser (kept empty to save memory). */
  attributes?: MFTAttribute[];
  fileName: string;
  /** Full path (e.g. C:\\Users\\me\\a.txt). Only set for records loaded from the index database. */
  fullPath?: string;
  parentRecordNumber: number;
  creationTime: Date;
  modificationTime: Date;
  accessTime: Date;
  mftModificationTime: Date;
  allocatedSize: bigint;
  realSize: bigint;
  fileAttributes: FileAttributes;
}

/** Result of parsing one raw MFT record (adds the fields the indexer needs). */
export interface ParsedRecord extends MFTRecord {
  /** 0 for a base record; otherwise the record number of the base record this extension belongs to. */
  baseRecordNumber: number;
  /** True if the record contains an unnamed $DATA attribute that carries size information (first extent). */
  hasSizedData: boolean;
  /** True if the record has an $ATTRIBUTE_LIST (some attributes live in extension records). */
  hasAttributeList: boolean;
  /** Data runs of the unnamed $DATA attribute (only when requested, e.g. for the $MFT record itself). */
  dataRuns?: DataRun[];
  /** Last VCN of the unnamed non-resident $DATA attribute in this record (only when data runs were requested). */
  dataLastVcn?: bigint;
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

/** A contiguous extent of a non-resident attribute. Both fields are in BYTES. */
export interface DataRun {
  /** Length of the run in bytes. */
  length: bigint;
  /** Absolute byte offset on the volume (LCN * bytesPerCluster). Meaningless when isSparse. */
  offset: bigint;
  isSparse: boolean;
}

/** Decoded FSCTL_GET_NTFS_VOLUME_DATA result. */
export interface NtfsVolumeData {
  volumeSerialNumber: bigint;
  numberSectors: bigint;
  totalClusters: bigint;
  freeClusters: bigint;
  totalReserved: bigint;
  bytesPerSector: number;
  bytesPerCluster: number;
  bytesPerFileRecordSegment: number;
  clustersPerFileRecordSegment: number;
  mftValidDataLength: bigint;
  mftStartLcn: bigint;
  mft2StartLcn: bigint;
  mftZoneStart: bigint;
  mftZoneEnd: bigint;
}

/** Anything that can read raw bytes from a volume (real volume handle, or an in-memory image in tests). */
export interface VolumeReader {
  /** Read exactly `length` bytes starting at absolute byte `offset`. Alignment is handled internally. */
  read(offset: bigint, length: number): Buffer;
  close(): void;
}

export interface DriveInfo {
  letter: string;
  type: string;
  totalSpace: bigint;
  freeSpace: bigint;
  usedSpace: bigint;
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
  driveLetter?: string;
  /**
   * Restrict indexing to these paths/name-patterns, or exclude them (only one of the two may be set).
   * A path entry (contains \\ or /) covers itself and everything below it; anything else is a glob
   * pattern (*, ?) matched against a bare file/directory name, e.g. "node_modules", "*.tmp".
   */
  only?: string[];
  exclude?: string[];
  /** Index files with the Hidden attribute (default: true). */
  includeHidden?: boolean;
  /** Index files with the System attribute, e.g. hiberfil.sys, pagefile.sys, $MFT (default: true). */
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
  /** Set when the index was built with --only / --exclude; absent for a full, unrestricted index. */
  scope?: IndexScopeInfo;
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

export interface FileSearchResult {
  files: MFTRecord[];
  totalMatches: number;
  searchTime: number;
}

/** One row of the "largest directories" report. */
export interface LargestDirectory {
  recordNumber: number;
  path: string;
  /** Total size of all files below this directory (recursive), in bytes. */
  size: bigint;
  /** Number of files below this directory (recursive). */
  fileCount: number;
}

/** Number of entries in one result slice (page). Results are never truncated: ask for the next page. */
export const PAGE_SIZE = 50;

/** One slice of a (possibly very large) result set. */
export interface Page<T> {
  items: T[];
  /** Total number of matching entries across ALL pages. */
  total: number;
  /** 1-based page number of `items`. */
  page: number;
  pageSize: number;
  totalPages: number;
  /** 0-based index of the first item of this page within the whole result set. */
  offset: number;
  hasMore: boolean;
}

/** Filters shared by every query. */
export interface EntryFilter {
  /** Include entries with the Hidden attribute (default true). */
  includeHidden?: boolean;
  /** Include entries with the System attribute (default true). */
  includeSystem?: boolean;
  /**
   * File types: category names (image, video, audio, document, ebook, archive, disk_image, executable, code,
   * database, font), "folder", and/or extensions such as "mkv" or ".mkv". Empty/undefined = any type.
   */
  types?: string[];
  /** 1-based page number (default 1). */
  page?: number;
}

export interface FindCriteria extends EntryFilter {
  /** Name substring (case-insensitive). If it contains "\\" or "/" it is matched against the full path. */
  query?: string;
  /** Size range in bytes (inclusive). Using either restricts the result to files. */
  minSize?: bigint;
  maxSize?: bigint;
  /** Modification time range (inclusive). */
  after?: Date;
  before?: Date;
  /** Restrict to files (exclude directories). */
  filesOnly?: boolean;
}

export type SortOrder = 'relevance' | 'size' | 'date';

/** What scope (if any) the current index was built with - persisted so queries/re-index can report it. */
export interface IndexScopeInfo {
  mode: 'none' | 'exclude' | 'only';
  entries: readonly string[];
}