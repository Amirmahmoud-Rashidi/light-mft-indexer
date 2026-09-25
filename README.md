# MFT Indexer - Fast File System Indexer with MCP Server

Reads the NTFS Master File Table (MFT) directly, WizTree-style, into a SQLite index and exposes fast
file search / disk-usage tools to AI assistants through an MCP server.

## Features

- **MFT-based indexing**: reads `$MFT` in large sequential chunks (follows its data runs, applies NTFS fixups)
- **Instant search** by name, path, file type, size, modification date, hidden/system over a local SQLite index; results are paged (50 per page), never truncated
- **Recursive directory sizes** ("what is eating my disk?")
- **MCP server** (stdio) with 10 tools, **CLI** for the same operations
- **No compiler needed**: native access uses [koffi](https://koffi.dev) (prebuilt binaries). No Visual Studio, no node-gyp.

## Requirements

- Windows 10/11, NTFS volumes
- Node.js **22.12 or newer** (LTS recommended)
- **Administrator** rights for `index` only (raw volume access). Searching an existing index does not need them.

## Quick start

```bat
npm install
npm run build
npm test

:: from an elevated terminal (Run as administrator):
node dist\cli\index.js index C

:: afterwards, from any terminal:
node dist\cli\index.js search C report
node dist\cli\index.js largest C --type dirs
```

Indexes are stored in `%LOCALAPPDATA%\mft-indexer\mft-index-<DRIVE>.db`
(override with the `MFT_INDEXER_DATA_DIR` environment variable).

## MCP configuration

Example (`claude_desktop_config.json` or any MCP client):

```json
{
  "mcpServers": {
    "mft-indexer": {
      "command": "node",
      "args": ["E:\\programming\\projects\\mft-indexer\\dist\\mcp\\server.js"]
    }
  }
}
```

Workflow: run the `index_drive` tool once per drive (the MCP host must be started as Administrator for
that call, or index from an elevated CLI instead), then use the search tools as often as you like. All
search tools work from the index and return a clear error if the drive has not been indexed yet.

| Tool | Purpose |
|------|---------|
| `index_drive` | Build/refresh the index of an NTFS drive (needs Administrator). Leave `includeHidden`/`includeSystem` at their default (`true`): hidden and system files (`hiberfil.sys`, `pagefile.sys`, `$MFT`, ...) are filtered at search time, not at index time |
| `search_files` | General search: name/path text and any combination of type, size range, date range, hidden/system |
| `search_by_size` | Files in a size range (either bound optional), largest first |
| `search_by_date` | Entries modified in a date range (either bound optional), newest first |
| `get_largest_files` / `get_largest_directories` | All files / directories ordered by size (directory sizes are recursive) |
| `list_file_types` | Show the preset file-type categories and their extensions |
| `get_disk_usage` / `get_index_stats` / `list_drives` | Volume and index information |

### Paging: no result limit, 50 entries per page

There is no `limit` parameter and results are never cut off. Every list tool returns one page of **50 entries**,
the **total** number of matches and whether more exist, e.g.:

```
Found 1,234 entries. Showing 1-50 (page 1 of 25).
...
More results: call search_files again with page=2 (1,184 more).
```

Pass `page` (1-based) to get the next slice. Ordering is deterministic, so pages never overlap or skip entries.

### Filters shared by all list tools

| Parameter | Meaning |
|-----------|---------|
| `types` | Only these file types (OR-combined). Presets: `image`, `video`, `audio`, `document`, `ebook`, `archive`, `disk_image`, `executable`, `code`, `database`, `font`; `folder` = directories. Any other format: give its extension (`"mkv"`, `".psd"`, `"*.xyz"`). Aliases such as `videos`, `pictures`, `docs`, `music` work too. Example: `["video", "iso", ".xyz"]` |
| `includeHidden` | Include entries with the Hidden attribute (default `true`) |
| `includeSystem` | Include entries with the System attribute, e.g. `hiberfil.sys` (default `true`) |
| `page` | Page number, default 1 |

`search_files` additionally takes `query`, `minSize`/`maxSize` (bytes or with a unit: `"500MB"`, `"1.5GB"`) and
`after`/`before` (ISO 8601; a bare `before` date means the end of that day, UTC). The hidden/system filters look at
an entry's own attributes; for `get_largest_directories` they also change the recursive sizes (with
`includeSystem: false` a directory's size no longer counts the system files inside it).

Examples an AI can issue: *all videos over 1 GB* (`types: ["video"], minSize: "1GB"`), *everything modified in
January without hidden files* (`after: "2025-01-01", before: "2025-01-31", includeHidden: false`), *the next page*
(`page: 2`).

CLI equivalents: `search <drive> [query] -f video,.xyz --min-size 1GB --after 2025-01-01 --no-hidden --no-system -p 2`
and `largest <drive> -t files|dirs -f iso --no-system -p 2`.

## Architecture

```
src/
├── mft/
│   ├── win32.ts     # koffi bindings: CreateFileW, DeviceIoControl, ReadFile, ... + Volume (aligned reads)
│   ├── parser.ts    # pure MFT record parsing (fixups, attributes, data runs) + MFTParser ($MFT scan)
│   ├── indexer.ts   # single-pass scan -> SQLite, directory paths, recursive sizes, queries
│   ├── drive.ts     # drive-letter validation, data directory
│   ├── file-types.ts # preset file-type categories + custom extensions
│   ├── args.ts      # argument parsing shared by MCP and CLI (sizes with units, dates, types, page)
│   └── types.ts
├── mcp/server.ts    # MCP server
├── cli/index.ts     # CLI
├── reporter/        # Windows disk / memory reporting
└── vector/          # experimental, NOT exposed (see note below)
tests/               # synthetic NTFS volume (fragmented $MFT, fixups, DOS names, extension records, ...)
```

## Known limitations

- Windows / NTFS only. ReFS, FAT and exFAT volumes are not supported.
- If `$MFT` itself is described by an `$ATTRIBUTE_LIST` (extremely fragmented MFT), indexing stops with an
  explicit error instead of producing a partial index.
- Files that have several hard links are indexed once, under their preferred name.
- File sizes are the logical size of the unnamed `$DATA` stream; alternate data streams are not counted.
- The index is a snapshot: re-run `index` to refresh it (USN-journal incremental updates are not implemented).
- `src/vector` uses hash-derived pseudo-embeddings, which are **not semantic**. It is kept for reference but
  deliberately not exposed via MCP.
- Real-volume access could only be tested against synthetic NTFS images (see `tests/`). Please test
  `index` on a real drive and report problems.