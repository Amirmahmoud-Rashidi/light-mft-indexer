#!/usr/bin/env node
// CLI Entry Point
import { Command } from 'commander';
import { parseDate, parseFilter, parseSize } from '../mft/args';
import { createIndexer, MFTIndexer } from '../mft/indexer';
import { EntryFilter, Page } from '../mft/types';
import { createDiskReporter } from '../reporter';
import { createMCPServer } from '../mcp';
import chalk from 'chalk';
import ora from 'ora';

const program = new Command();

program
  .name('mft-indexer')
  .description('Fast MFT-based file indexer with MCP server - WizTree alternative')
  .version('1.0.0');

program
  .command('index')
  .description('Index a drive using MFT')
  .argument('<driveLetter>', 'Drive letter (e.g., C)')
  .option('--no-hidden', 'Exclude files with the Hidden attribute')
  .option('--no-system', 'Exclude files with the System attribute (hiberfil.sys, pagefile.sys, ...)')
  .option('-b, --batch-size <number>', 'Batch size for indexing', '1000')
  .option(
    '--only <path-or-pattern...>',
    'Only index these paths (with everything below them) and/or name patterns (e.g. "C:\\Projects" or "*.iso"). Cannot combine with --exclude'
  )
  .option(
    '--exclude <path-or-pattern...>',
    'Skip these paths (with everything below them) and/or name patterns (e.g. "node_modules", "*.tmp"). Cannot combine with --only'
  )
  .action(async (driveLetter, options) => {
    const spinner = ora(`Indexing ${driveLetter}:...`).start();

    try {
      const indexer = createIndexer(driveLetter, {
        includeHidden: options.hidden,
        includeSystem: options.system,
        batchSize: parseInt(options.batchSize, 10),
        only: options.only,
        exclude: options.exclude,
      });
      
      indexer.on('progress', (stats) => {
        spinner.text = `Indexing ${driveLetter}: ${stats.files.toLocaleString()} files, ${stats.directories.toLocaleString()} dirs, ${formatBytes(BigInt(stats.size))}`;
      });
      
      const stats = await indexer.index();
      
      spinner.succeed(chalk.green(`Indexing complete!`));
      console.log(chalk.cyan('\nIndex Statistics:'));
      console.log(`  Files: ${chalk.yellow(stats.totalFiles.toLocaleString())}`);
      console.log(`  Directories: ${chalk.yellow(stats.totalDirectories.toLocaleString())}`);
      console.log(`  Total Size: ${chalk.yellow(formatBytes(stats.totalSize))}`);
      console.log(`  Duration: ${chalk.yellow(`${stats.duration}ms`)}`);
      console.log(`  Indexed at: ${chalk.yellow(stats.indexedAt.toISOString())}`);
      if (stats.scope) {
        console.log(`  Scope: ${chalk.yellow(stats.scope.mode)} ${stats.scope.entries.map((e) => `"${e}"`).join(', ')}`);
      }

      indexer.close();
    } catch (error) {
      spinner.fail(chalk.red(`Indexing failed: ${error instanceof Error ? error.message : error}`));
      process.exit(1);
    }
  });

/** Open the index of a drive, or explain how to create it. */
function openIndexed(driveLetter: string): MFTIndexer {
  const indexer = createIndexer(driveLetter);
  if (!indexer.hasIndex()) {
    console.error(chalk.red(`Drive ${driveLetter.toUpperCase()} is not indexed yet. Run: mft-indexer index ${driveLetter} (as Administrator)`));
    indexer.close();
    process.exit(1);
  }
  return indexer;
}

/** Filter options shared by `search` and `largest`. Commander turns --no-hidden into hidden=false. */
function filterFromOptions(options: any): EntryFilter {
  return parseFilter({
    types: options.fileTypes,
    includeHidden: options.hidden === false ? false : undefined,
    includeSystem: options.system === false ? false : undefined,
    page: options.page,
  });
}

function printPage<T>(what: string, page: Page<T>, line: (item: T) => string): void {
  if (page.total === 0) {
    console.log(chalk.yellow(`\nNo ${what} found.`));
    return;
  }
  if (page.items.length === 0) {
    console.log(chalk.yellow(`\nPage ${page.page} is past the end (${page.totalPages} page(s), ${page.total.toLocaleString()} ${what}).`));
    return;
  }
  const first = page.offset + 1;
  const last = page.offset + page.items.length;
  const noun = page.total === 1 ? ({ entries: 'entry', files: 'file', directories: 'directory' } as Record<string, string>)[what] ?? what : what;
  console.log(chalk.cyan(`\nFound ${page.total.toLocaleString()} ${noun}. Showing ${first === last ? first : `${first}-${last}`} (page ${page.page} of ${page.totalPages}):\n`));
  page.items.forEach((item, i) => console.log(`  ${chalk.yellow(`${first + i}.`)} ${line(item)}`));
  if (page.hasMore) console.log(chalk.gray(`\nNext page: add --page ${page.page + 1}`));
}

const attrTags = (attrs: number) => `${attrs & 0x2 ? ' [hidden]' : ''}${attrs & 0x4 ? ' [system]' : ''}`;

program
  .command('search')
  .description('Search for files (paged, 50 per page). The query is optional if other filters are given')
  .argument('<driveLetter>', 'Drive letter')
  .argument('[query]', 'Name text (or path if it contains \\ or /)')
  .option('-f, --file-types <list>', 'File types, comma separated: presets (video, image, audio, document, archive, ...), "folder", or extensions (mkv,.psd)')
  .option('--min-size <size>', 'Minimum size in bytes or with a unit (500MB, 1.5GB)')
  .option('--max-size <size>', 'Maximum size in bytes or with a unit')
  .option('--after <date>', 'Modified on/after (ISO 8601)')
  .option('--before <date>', 'Modified on/before (ISO 8601)')
  .option('--no-hidden', 'Exclude hidden entries')
  .option('--no-system', 'Exclude system entries')
  .option('-p, --page <number>', 'Page number (50 entries per page)', '1')
  .action(async (driveLetter, query, options) => {
    const indexer = openIndexed(driveLetter);
    try {
      const page = indexer.find(
        {
          ...filterFromOptions(options),
          query,
          minSize: parseSize('--min-size', options.minSize),
          maxSize: parseSize('--max-size', options.maxSize),
          after: parseDate('--after', options.after),
          before: parseDate('--before', options.before, true),
        },
        'relevance'
      );
      printPage('entries', page, (file) => {
        const isDir = (file.flags & 0x02) !== 0;
        return `${file.fullPath} ${isDir ? chalk.gray('[dir]') : chalk.gray(`(${formatBytes(file.realSize)})`)}${chalk.gray(attrTags(file.fileAttributes))} ${chalk.gray(`- ${file.modificationTime.toISOString()}`)}`;
      });
    } finally {
      indexer.close();
    }
  });

program
  .command('largest')
  .description('Show largest files or directories (paged, 50 per page)')
  .argument('<driveLetter>', 'Drive letter')
  .option('-t, --type <type>', 'What to list: files or dirs', 'files')
  .option('-f, --file-types <list>', 'Only these file types (files only), e.g. video,iso')
  .option('--no-hidden', 'Exclude hidden entries (directory sizes then exclude hidden files too)')
  .option('--no-system', 'Exclude system entries (directory sizes then exclude system files too)')
  .option('-p, --page <number>', 'Page number (50 entries per page)', '1')
  .action(async (driveLetter, options) => {
    const indexer = openIndexed(driveLetter);
    try {
      const filter = filterFromOptions(options);
      if (options.type === 'files') {
        printPage('files', indexer.getLargestFiles(filter), (file) => `${file.fullPath} ${chalk.gray(`(${formatBytes(file.realSize)})`)}${chalk.gray(attrTags(file.fileAttributes))}`);
      } else {
        printPage('directories', indexer.getLargestDirectories(filter), (dir) => `${dir.path} ${chalk.gray(`(${formatBytes(dir.size)} - ${dir.fileCount.toLocaleString()} files)`)}`);
      }
    } finally {
      indexer.close();
    }
  });

program
  .command('report')
  .description('Generate disk usage report')
  .argument('[driveLetter]', 'Drive letter (optional)')
  .action((driveLetter) => {
    const reporter = createDiskReporter();
    console.log(reporter.generateReport(driveLetter?.toUpperCase()));
  });

program
  .command('drives')
  .description('List all available drives')
  .action(() => {
    const reporter = createDiskReporter();
    const drives = reporter.getDrives();
    
    console.log(chalk.cyan('\nAvailable Drives:\n'));
    for (const drive of drives) {
      const usagePercent = drive.totalSpace > 0n ? Number((drive.totalSpace - drive.freeSpace) * 100n / drive.totalSpace) : 0;
      console.log(`  ${chalk.yellow(drive.letter + ':')} (${drive.type}) ${formatBytes(drive.usedSpace)} / ${formatBytes(drive.totalSpace)} ${chalk.gray(`(${usagePercent.toFixed(1)}% used)`)}`);
    }
  });

program
  .command('mcp')
  .description('Start MCP server')
  .action(async () => {
    const server = createMCPServer();
    await server.start();
  });

function formatBytes(bytes: bigint): string {
  const num = Number(bytes);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  if (num < 1024 * 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(num / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
}

if (require.main === module) {
  program.parseAsync().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}