# MFT Indexer - Fast File System Indexer with MCP Server

A high-performance file system indexer that reads directly from the Windows Master File Table (MFT) for instant file discovery, similar to WizTree. Includes an MCP server for AI-assisted file operations and disk reporting.

## Features

- **MFT-based indexing**: Reads NTFS Master File Table directly for instant file discovery
- **Vector database**: Fast semantic search across file metadata
- **MCP Server**: Exposes file operations and disk reporting to AI assistants
- **Disk Reporter**: Real-time disk usage and memory status reporting
- **WizTree-like performance**: Millions of files indexed in seconds

## Architecture

```
src/
├── mft/          # MFT parser and NTFS reader
├── vector/       # Vector database for file embeddings
├── mcp/          # MCP server implementation
└── reporter/     # Disk and memory reporting
```

## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run the MCP server
npm run start:mcp

# Index a drive
npm run index -- C:
```

## Requirements

- Windows 10/11 (for MFT access)
- Node.js 18+
- Administrator privileges (for raw disk access)