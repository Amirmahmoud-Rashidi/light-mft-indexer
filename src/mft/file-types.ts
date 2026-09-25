// File-type filtering: preset categories (video, image, ...) plus arbitrary extensions.
//
// A "type" token given by a user or an AI is either
//   - a category name (or a common alias such as "movies", "pictures", "docs"),
//   - the special token "folder" (directories only), or
//   - a file extension, with or without a leading dot or "*." ("mkv", ".mkv", "*.mkv").

/** Preset categories. Extensions are lower-case, without the dot. */
export const FILE_TYPE_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  image: [
    'jpg', 'jpeg', 'jpe', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'ico', 'svg', 'heic', 'heif', 'avif',
    'psd', 'ai', 'xcf', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2',
  ],
  video: [
    'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'm2ts', 'mts', 'vob', '3gp', 'ogv',
    'divx', 'rmvb',
  ],
  audio: [
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'opus', 'aiff', 'aif', 'ape', 'mid', 'midi', 'amr',
  ],
  document: [
    'pdf', 'doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'txt', 'md', 'tex', 'pages', 'xls', 'xlsx', 'xlsm', 'ods',
    'csv', 'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key', 'xps', 'one',
  ],
  ebook: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab', 'arj', 'z'],
  disk_image: ['iso', 'img', 'bin', 'vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2', 'wim', 'esd', 'dmg'],
  executable: ['exe', 'msi', 'msix', 'appx', 'dll', 'bat', 'cmd', 'com', 'scr', 'ps1', 'jar', 'apk'],
  code: [
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'pyc', 'java', 'class', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs',
    'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'lua', 'r', 'dart', 'vue', 'svelte', 'html', 'htm',
    'css', 'scss', 'sass', 'less', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sql', 'sh', 'bash', 'ipynb',
  ],
  database: ['db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'mdf', 'ldf', 'ndf', 'sdf', 'dbf', 'bak'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'fon', 'ttc'],
};

/** Aliases people (and AIs) commonly use instead of the canonical category name. */
const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  images: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', pic: 'image', pics: 'image',
  videos: 'video', movie: 'video', movies: 'video', film: 'video', films: 'video', clip: 'video', clips: 'video',
  audios: 'audio', music: 'audio', song: 'audio', songs: 'audio', sound: 'audio', sounds: 'audio',
  documents: 'document', doc_files: 'document', docs: 'document', office: 'document', text: 'document',
  ebooks: 'ebook', book: 'ebook', books: 'ebook',
  archives: 'archive', compressed: 'archive', zipped: 'archive',
  disk_images: 'disk_image', diskimage: 'disk_image', diskimages: 'disk_image', 'disk-image': 'disk_image',
  executables: 'executable', program: 'executable', programs: 'executable', app: 'executable', apps: 'executable', binary: 'executable', binaries: 'executable',
  source: 'code', sources: 'code', script: 'code', scripts: 'code', sourcecode: 'code',
  databases: 'database', dbs: 'database',
  fonts: 'font', typeface: 'font', typefaces: 'font',
};

/** Pseudo-type: matches directories only. */
export const FOLDER_TYPE = 'folder';
const FOLDER_ALIASES = new Set(['folder', 'folders', 'dir', 'dirs', 'directory', 'directories']);

export interface ResolvedTypes {
  /** Lower-case extensions (no dot) to match. Empty when only folders were requested. */
  extensions: string[];
  /** True if directories should match as well. */
  includeFolders: boolean;
  /** Human-readable description of what was matched, e.g. ["video", ".xyz"]. */
  labels: string[];
}

/** Extension of a file name in lower case without the dot ("" if none). Windows semantics: text after the last dot. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

/** The category names, for documentation / error messages. */
export function listCategories(): string[] {
  return Object.keys(FILE_TYPE_CATEGORIES);
}

/**
 * Turn user supplied type tokens into a set of extensions.
 * Unknown tokens are treated as extensions (that is the "custom format" path).
 * Throws for tokens that cannot possibly be an extension.
 */
export function resolveTypes(types: readonly string[] | undefined): ResolvedTypes {
  const extensions = new Set<string>();
  const labels: string[] = [];
  let includeFolders = false;

  for (const raw of types ?? []) {
    let token = String(raw).trim().toLowerCase();
    if (token === '') continue;

    if (FOLDER_ALIASES.has(token)) {
      includeFolders = true;
      labels.push(FOLDER_TYPE);
      continue;
    }

    const category = FILE_TYPE_CATEGORIES[token] ? token : CATEGORY_ALIASES[token];
    if (category) {
      for (const ext of FILE_TYPE_CATEGORIES[category]) extensions.add(ext);
      labels.push(category);
      continue;
    }

    // custom extension: accept ".mkv", "*.mkv", "mkv"
    token = token.replace(/^\*?\./, '');
    if (!/^[^\s\\/:*?"<>|.]+$/.test(token)) {
      throw new Error(
        `Invalid file type "${raw}". Use a category (${listCategories().join(', ')}, folder) or a file extension such as "mkv" or ".mkv".`
      );
    }
    extensions.add(token);
    labels.push('.' + token);
  }
  return { extensions: [...extensions], includeFolders, labels };
}