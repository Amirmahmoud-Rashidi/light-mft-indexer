// Disk Reporter - Fast disk usage and memory reporting
import { Win32API } from '../mft/win32';
import { DiskUsage, FileInfo, DirectoryInfo, DriveInfo } from '../mft/types';
import * as os from 'os';

export class DiskReporter {
  private driveCache: Map<string, DriveInfo> = new Map();
  private cacheTimeout = 30000; // 30 seconds

  getDrives(): DriveInfo[] {
    const drives: DriveInfo[] = [];
    const logicalDrives = Win32API.getLogicalDrives();
    
    for (const drive of logicalDrives) {
      const driveType = Win32API.getDriveType(drive);
      let typeStr = 'Unknown';
      
      switch (driveType) {
        case 2: typeStr = 'Removable'; break;
        case 3: typeStr = 'Fixed'; break;
        case 4: typeStr = 'Network'; break;
        case 5: typeStr = 'CD-ROM'; break;
        case 6: typeStr = 'RAM Disk'; break;
      }
      
      try {
        const space = Win32API.getDiskFreeSpace(drive);
        drives.push({
          letter: drive.replace(':', ''),
          type: typeStr,
          totalSpace: space.totalBytes,
          freeSpace: space.freeBytes,
          usedSpace: space.totalBytes - space.freeBytes,
        });
      } catch {
        drives.push({
          letter: drive.replace(':', ''),
          type: typeStr,
          totalSpace: 0n,
          freeSpace: 0n,
          usedSpace: 0n,
        });
      }
    }
    
    return drives;
  }

  getDiskUsage(driveLetter: string): DiskUsage {
    const drive = `${driveLetter.toUpperCase()}:`;
    const space = Win32API.getDiskFreeSpace(drive);
    
    const totalSpace = space.totalBytes;
    const freeSpace = space.freeBytes;
    const usedSpace = totalSpace - freeSpace;
    const usagePercent = totalSpace > 0n ? Number(usedSpace * 100n / totalSpace) : 0;
    
    // Get file counts from MFT indexer if available, otherwise estimate
    const fileCount = 0;
    const directoryCount = 0;
    
    return {
      driveLetter: driveLetter.toUpperCase(),
      totalSpace,
      freeSpace,
      usedSpace,
      usagePercent,
      fileCount,
      directoryCount,
      largestFiles: [],
      largestDirectories: [],
    };
  }

  getMemoryUsage(): { total: bigint; free: bigint; used: bigint; usagePercent: number } {
    const totalMem = BigInt(os.totalmem());
    const freeMem = BigInt(os.freemem());
    const usedMem = totalMem - freeMem;
    const usagePercent = Number(usedMem * 100n / totalMem);
    
    return {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usagePercent,
    };
  }

  getSystemInfo(): {
    platform: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    totalMemory: bigint;
    freeMemory: bigint;
    uptime: number;
    loadAverage: number[];
  } {
    const cpus = os.cpus();
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpus: cpus.length,
      cpuModel: cpus[0]?.model || 'Unknown',
      totalMemory: BigInt(os.totalmem()),
      freeMemory: BigInt(os.freemem()),
      uptime: os.uptime(),
      loadAverage: os.loadavg(),
    };
  }

  formatBytes(bytes: bigint): string {
    const num = Number(bytes);
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
    if (num < 1024 * 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    return `${(num / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  generateReport(driveLetter?: string): string {
    const lines: string[] = [];
    lines.push('=== System Report ===');
    lines.push('');
    
    // System info
    const sysInfo = this.getSystemInfo();
    lines.push('System Information:');
    lines.push(`  Platform: ${sysInfo.platform} (${sysInfo.arch})`);
    lines.push(`  CPUs: ${sysInfo.cpus} x ${sysInfo.cpuModel}`);
    lines.push(`  Memory: ${this.formatBytes(sysInfo.freeMemory)} free / ${this.formatBytes(sysInfo.totalMemory)} total`);
    lines.push(`  Uptime: ${this.formatDuration(sysInfo.uptime * 1000)}`);
    lines.push(`  Load: ${sysInfo.loadAverage.map(l => l.toFixed(2)).join(', ')}`);
    lines.push('');
    
    // Memory usage
    const memUsage = this.getMemoryUsage();
    lines.push('Memory Usage:');
    lines.push(`  Used: ${this.formatBytes(memUsage.used)} (${memUsage.usagePercent.toFixed(1)}%)`);
    lines.push(`  Free: ${this.formatBytes(memUsage.free)}`);
    lines.push(`  Total: ${this.formatBytes(memUsage.total)}`);
    lines.push('');
    
    // Drives
    const drives = this.getDrives();
    lines.push('Drives:');
    for (const drive of drives) {
      const usagePercent = drive.totalSpace > 0n ? Number((drive.totalSpace - drive.freeSpace) * 100n / drive.totalSpace) : 0;
      lines.push(`  ${drive.letter}: (${drive.type}) ${this.formatBytes(drive.usedSpace)} / ${this.formatBytes(drive.totalSpace)} (${usagePercent.toFixed(1)}% used)`);
    }
    lines.push('');
    
    // Detailed drive report if specified
    if (driveLetter) {
      const usage = this.getDiskUsage(driveLetter);
      lines.push(`=== Drive ${driveLetter.toUpperCase()}: Detailed Report ===`);
      lines.push(`Total Space: ${this.formatBytes(usage.totalSpace)}`);
      lines.push(`Used Space: ${this.formatBytes(usage.usedSpace)} (${usage.usagePercent.toFixed(1)}%)`);
      lines.push(`Free Space: ${this.formatBytes(usage.freeSpace)}`);
      lines.push(`Files: ${usage.fileCount.toLocaleString()}`);
      lines.push(`Directories: ${usage.directoryCount.toLocaleString()}`);
    }
    
    return lines.join('\n');
  }
}

export function createDiskReporter(): DiskReporter {
  return new DiskReporter();
}