// CLI Entry Point
import { Command } from 'commander';
import { MFTIndexer, createIndexer } from '../mft';
import { DiskReporter, createDiskReporter } from '../reporter';
import { MFTMCPServer, createMCPServer } from '../mcp';
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
  .option('-h, --hidden', 'Include hidden files', false)
  .option('-s, --system', 'Include system files', false)
  .option('-b, --batch-size <number>', 'Batch size for indexing', '1000')
  .action(async (driveLetter, options) => {
    const spinner = ora(`Indexing ${driveLetter}:...`).start();
    
    try {
      const indexer = createIndexer(driveLetter.toUpperCase(), {
        includeHidden: options.hidden,
        includeSystem: options.system,
        batchSize: parseInt(options.batchSize),
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
      
      indexer.close();
    } catch (error) {
      spinner.fail(chalk.red(`Indexing failed: ${error}`));
      process.exit(1);
    }
  });

program
  .command('search')
  .description('Search for files')
  .argument('<driveLetter>', 'Drive letter')
  .argument('<query>', 'Search query')
  .option('-l, --limit <number>', 'Limit results', '100')
  .action(async (driveLetter, query, options) => {
    const indexer = createIndexer(driveLetter.toUpperCase());
    const results = indexer.search(query, parseInt(options.limit));
    
    console.log(chalk.cyan(`\nFound ${results.length} files matching "${query}":\n`));
    for (const file of results) {
      console.log(`  ${file.fileName} ${chalk.gray(`(${formatBytes(file.realSize)})`)} ${chalk.gray(`- ${file.modificationTime.toISOString()}`)}`);
    }
    
    indexer.close();
  });

program
  .command('largest')
  .description('Show largest files or directories')
  .argument('<driveLetter>', 'Drive letter')
  .option('-t, --type <type>', 'Type: files or dirs', 'files')
  .option('-l, --limit <number>', 'Limit results', '50')
  .action(async (driveLetter, options) => {
    const indexer = createIndexer(driveLetter.toUpperCase());
    
    if (options.type === 'files') {
      const results = indexer.getLargestFiles(parseInt(options.limit));
      console.log(chalk.cyan(`\nTop ${results.length} largest files on ${driveLetter}:\n`));
      for (let i = 0; i < results.length; i++) {
        const file = results[i];
        console.log(`  ${chalk.yellow(`${i + 1}.`)} ${file.fileName} ${chalk.gray(`(${formatBytes(file.realSize)})`)}`);
      }
    } else {
      const results = indexer.getLargestDirectories(parseInt(options.limit));
      console.log(chalk.cyan(`\nTop ${results.length} largest directories on ${driveLetter}:\n`));
      for (let i = 0; i < results.length; i++) {
        const dir = results[i];
        console.log(`  ${chalk.yellow(`${i + 1}.`)} Record ${dir.record_number} ${chalk.gray(`(${formatBytes(BigInt(dir.total_size))} - ${dir.file_count} files)`)}`);
      }
    }
    
    indexer.close();
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

program.parse();