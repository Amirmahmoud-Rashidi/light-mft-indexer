// Small helpers that do not touch any native code (safe to import anywhere).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Normalize user/AI supplied drive input ("c", "C:", "c:\") to a single upper-case letter.
 * The value ends up in a raw device path (\\.\C:) and in file names, so it is validated strictly.
 */
export function normalizeDriveLetter(input: string): string {
  const m = /^\s*([a-zA-Z]):?[\\/]?\s*$/.exec(String(input));
  if (!m) {
    throw new Error(`Invalid drive letter: "${input}". Use a single letter such as "C".`);
  }
  return m[1].toUpperCase();
}

/**
 * Directory where index databases are stored. MCP hosts start servers with an unpredictable
 * working directory, so we never rely on process.cwd().
 * Override with the MFT_INDEXER_DATA_DIR environment variable.
 */
export function getDataDir(): string {
  const dir =
    process.env.MFT_INDEXER_DATA_DIR ||
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'mft-indexer');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getIndexDbPath(driveLetter: string): string {
  return path.join(getDataDir(), `mft-index-${normalizeDriveLetter(driveLetter)}.db`);
}
