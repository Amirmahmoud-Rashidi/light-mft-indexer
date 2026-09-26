// Index scope: --only / --exclude filters for the index() operation.
//
// A scope entry is either a path (contains \ or / and is matched, case-insensitively, against the full
// path and everything below it) or a name pattern (matched against just the file/directory name, glob-style
// with * and ?, e.g. "node_modules", "*.tmp", "$Recycle.Bin"). Which kind an entry is is auto-detected.
//
// Directories are ALWAYS scanned and kept in memory (their names/parents are needed to build every path,
// including paths outside the scope), but an excluded/out-of-scope directory contributes no files of its
// own and its entire subtree is skipped just as if it were never seen - this is what keeps a scoped index
// small and its queries fast, even though the $MFT itself is always read in full (that read is the same
// single sequential pass regardless of scope; see indexer.ts).

export type ScopeMode = 'none' | 'exclude' | 'only';

export interface IndexScope {
  mode: ScopeMode;
  /** Case-insensitive absolute path prefixes, normalized, no trailing separator, backslashes only. */
  paths: string[];
  /** Case-insensitive glob patterns (RegExp already compiled) matched against a bare name. */
  namePatterns: RegExp[];
  /** Original entries, for error messages / echoing back to the caller. */
  raw: readonly string[];
}

const EMPTY_SCOPE: IndexScope = { mode: 'none', paths: [], namePatterns: [], raw: [] };

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function normalizePath(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isPathEntry(entry: string): boolean {
  return /[\\/]/.test(entry);
}

/** Parse --only / --exclude entries (only one of the two may be given). Throws on invalid input. */
export function buildScope(
  driveLetter: string,
  only: readonly string[] | undefined,
  exclude: readonly string[] | undefined
): IndexScope {
  if (only && only.length > 0 && exclude && exclude.length > 0) {
    throw new Error('Use either "only" or "exclude", not both.');
  }
  const raw = (only && only.length > 0 ? only : exclude) ?? [];
  if (raw.length === 0) return EMPTY_SCOPE;
  const mode: ScopeMode = only && only.length > 0 ? 'only' : 'exclude';

  const paths: string[] = [];
  const namePatterns: RegExp[] = [];
  const driveRoot = `${driveLetter.toUpperCase()}:`;

  for (const entry of raw) {
    const text = String(entry).trim();
    if (text === '') continue;
    if (isPathEntry(text)) {
      let norm = normalizePath(text);
      // Accept a path with or without the drive prefix; without one, anchor it at this drive's root.
      if (!/^[a-z]:/.test(norm)) norm = normalizePath(driveRoot) + (norm.startsWith('\\') ? '' : '\\') + norm;
      if (!norm.startsWith(normalizePath(driveRoot))) {
        throw new Error(`"${text}" is not on drive ${driveLetter.toUpperCase()}: (indexing one drive at a time).`);
      }
      paths.push(norm);
    } else {
      namePatterns.push(globToRegExp(text));
    }
  }
  return { mode, paths, namePatterns, raw };
}

/** True if `name` (a bare file/directory name) matches one of the scope's name patterns. */
export function nameInScope(scope: IndexScope, name: string): boolean {
  return scope.namePatterns.some((re) => re.test(name));
}

/** True if `path` (a resolved full path, e.g. "C:\\Users\\me") is inside one of the scope's path prefixes. */
export function pathInScope(scope: IndexScope, path: string): boolean {
  const norm = normalizePath(path);
  return scope.paths.some((p) => norm === p || norm.startsWith(p + '\\'));
}

export function isEmptyScope(scope: IndexScope): boolean {
  return scope.paths.length === 0 && scope.namePatterns.length === 0;
}