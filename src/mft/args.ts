// Argument parsing shared by the MCP server and the CLI. Clients send whatever they like (numbers as strings,
// comma separated lists, ...), so nothing is trusted and every failure explains how to fix the input.
import { parsePage } from './indexer';
import { EntryFilter } from './types';

export function parseBool(name: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}: expected true or false, got "${String(value)}".`);
}

export function parseTypes(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\s]+/) : undefined;
  if (!list || list.some((t) => typeof t !== 'string')) {
    throw new Error('Invalid types: expected an array of strings such as ["video", "iso"].');
  }
  return list as string[];
}

const SIZE_UNITS: Record<string, number> = { '': 1, b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
export function parseSize(name: string, value: unknown): bigint | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(String(value).trim());
  // A fraction only makes sense together with a unit ("1.5GB"); "1.5" bytes is meaningless.
  if (!m || (m[2] === undefined && m[1].includes('.'))) {
    throw new Error(`Invalid ${name}: "${String(value)}". Use bytes ("1048576") or a unit ("500MB", "1.5GB").`);
  }
  if (m[2] === undefined) return BigInt(m[1]); // plain bytes, exact even above 2^53
  return BigInt(Math.round(Number(m[1]) * SIZE_UNITS[m[2].toLowerCase()]));
}

export function parseDate(name: string, value: unknown, endOfDay = false): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${name}: "${text}". Use ISO 8601, e.g. "2025-01-31" or "2025-01-31T12:00:00Z".`);
  }
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(date.getTime() + 24 * 3600 * 1000 - 1) : date;
}

export function parseFilter(args: any): EntryFilter {
  return {
    includeHidden: parseBool('includeHidden', args.includeHidden),
    includeSystem: parseBool('includeSystem', args.includeSystem),
    types: parseTypes(args.types),
    page: parsePage(args.page),
  };
}