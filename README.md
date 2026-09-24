# MFT Indexer - Fast File System Indexer with MCP Server

Reads the NTFS Master File Table (MFT) directly, WizTree-style, into a SQLite index and exposes fast
file search / disk-usage tools to AI assistants through an MCP server.

## Features

- **MFT-based indexing**: reads `$MFT` in large sequential chunks (follows its data runs, applies NTFS fixups)
- **Instant search** by name, path, size or modification date over a local SQLite index
- **Recursive directory sizes** ("what is eating my disk?")
- **MCP server** (stdio) with 9 tools, **CLI** for the same operations
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
| `index_drive` | Build/refresh the index of an NTFS drive (needs Administrator). Hidden and system files (`hiberfil.sys`, `pagefile.sys`, `$MFT`, ...) are included by default; pass `includeHidden: false` / `includeSystem: false` to skip them (CLI: `--no-hidden`, `--no-system`) |
| `search_files` | Name search (case-insensitive substring). A query containing `\` or `/` is matched against the full path |
| `search_by_size` / `search_by_date` | Range searches |
| `get_largest_files` / `get_largest_directories` | Top-N by size (directories are recursive) |
| `get_disk_usage` / `get_index_stats` / `list_drives` | Volume and index information |

## Architecture

```
src/
├── mft/
│   ├── win32.ts     # koffi bindings: CreateFileW, DeviceIoControl, ReadFile, ... + Volume (aligned reads)
│   ├── parser.ts    # pure MFT record parsing (fixups, attributes, data runs) + MFTParser ($MFT scan)
│   ├── indexer.ts   # single-pass scan -> SQLite, directory paths, recursive sizes, queries
│   ├── drive.ts     # drive-letter validation, data directory
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