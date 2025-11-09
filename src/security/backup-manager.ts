import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { getSimNow } from '../time-control';
import { DeviceRewardModel, TestDeviceRewardModel } from '../db/device-rewards-schema';
import { DeviceModel, TestDeviceModel } from '../db/devices-schema';
import { ProductModel } from '../db/products-schema';
import { withJobLock } from '../scheduler/job-lock';

interface BackupMetadata {
  timestamp: Date;
  recordCount: number;
  collections: string[];
  fileSize: number;
  integrity: string; // Simple hash for integrity check
}

export class BackupManager {
  private readonly backupRoot: string;
  private readonly backupDir: string;
  private readonly legacyBackupDir: string;
  private readonly retentionDays = 7;
  private readonly testMode = process.env.TEST_MODE === 'true';
  
  constructor() {
    this.backupRoot = path.join(process.cwd(), 'backups');
    this.backupDir = path.join(this.backupRoot, 'csv');
    this.legacyBackupDir = path.join(process.cwd(), '.backups', 'csv');
    this.ensureBackupDirectory();
    this.scheduleCleanup();
  }

  private async ensureBackupDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      await this.migrateLegacyBackups();
    } catch (error) {
      console.error('Failed to create backup directory:', error);
    }
  }

  private async migrateLegacyBackups(): Promise<void> {
    try {
      const legacyStats = await fs.stat(this.legacyBackupDir);
      if (!legacyStats.isDirectory()) return;

      const files = await fs.readdir(this.legacyBackupDir);
      if (files.length === 0) return;

      console.log(`📁 Migrating legacy backup files from ${this.legacyBackupDir} → ${this.backupDir}`);
      await fs.mkdir(this.backupDir, { recursive: true });

      for (const file of files) {
        const source = path.join(this.legacyBackupDir, file);
        const destination = path.join(this.backupDir, file);
        try {
          await fs.access(destination, fsConstants.F_OK);
          // Destination already exists; skip to avoid overwriting.
          continue;
        } catch {
          await fs.rename(source, destination);
        }
      }
    } catch {
      // Ignore if legacy directory does not exist.
    }
  }

  private getBackupFileName(date: Date, collection: string): string {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.backupDir, `${collection}-${dateStr}.csv`);
  }

  private getMetadataFileName(date: Date): string {
    const dateStr = date.toISOString().split('T')[0];
    return path.join(this.backupDir, `metadata-${dateStr}.json`);
  }

  private async calculateFileHash(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      // Simple hash using content length and first/last characters
      const hash = content.length.toString(16) + 
                   (content.charCodeAt(0) || 0).toString(16) + 
                   (content.charCodeAt(content.length - 1) || 0).toString(16);
      return hash;
    } catch {
      return 'unknown';
    }
  }

  private csvEscape(value: any): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  private arrayToCsvRow(array: any[]): string {
    return array.map(this.csvEscape).join(',');
  }

  public async createDailyBackup(): Promise<{
    success: boolean;
    backupFiles: string[];
    metadata: BackupMetadata;
    error?: string;
  }> {
    return await withJobLock('daily-backup', ['weekly-rollup', 'hourly-processing'], async () => {
      const now = getSimNow();
      const backupFiles: string[] = [];
      
      try {
        console.log('🔄 Starting daily CSV backup...');
        
        // Backup Device Rewards
        const deviceRewardsFile = await this.backupDeviceRewards(now);
        if (deviceRewardsFile) backupFiles.push(deviceRewardsFile);
        
        // Backup Devices
        const devicesFile = await this.backupDevices(now);
        if (devicesFile) backupFiles.push(devicesFile);
        
        // Backup Products
        const productsFile = await this.backupProducts(now);
        if (productsFile) backupFiles.push(productsFile);
        
        // Calculate total records and file sizes
        let totalRecords = 0;
        let totalSize = 0;
        const hashes: string[] = [];
        
        for (const file of backupFiles) {
          const stats = await fs.stat(file);
          totalSize += stats.size;
          
          const content = await fs.readFile(file, 'utf8');
          const lines = content.split('\n').filter(line => line.trim());
          totalRecords += Math.max(0, lines.length - 1); // Subtract header row
          
          const hash = await this.calculateFileHash(file);
          hashes.push(hash);
        }
        
        // Create metadata
        const metadata: BackupMetadata = {
          timestamp: now,
          recordCount: totalRecords,
          collections: ['device-rewards', 'devices', 'products'],
          fileSize: totalSize,
          integrity: hashes.join('-')
        };
        
        await fs.writeFile(
          this.getMetadataFileName(now), 
          JSON.stringify(metadata, null, 2)
        );
        
        console.log(`✅ Daily backup completed: ${totalRecords} records, ${Math.round(totalSize / 1024)}KB`);
        
        return { success: true, backupFiles, metadata };
        
      } catch (error) {
        console.error('❌ Daily backup failed:', error);
        return { 
          success: false, 
          backupFiles, 
          metadata: {} as BackupMetadata, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        };
      }
    });
  }

  private async backupDeviceRewards(date: Date): Promise<string | null> {
    try {
      const Model = this.testMode ? TestDeviceRewardModel : DeviceRewardModel;
      const devices = await Model.find({}).lean();
      
      if (devices.length === 0) return null;
      
      const filename = this.getBackupFileName(date, 'device-rewards');
      const headers = [
        'miner_key', 'total_pending', 'total_claimable', 'total_claimed',
        'reward_count', 'weekly_reward_count', 'first_reward_date', 'last_reward_date',
        'daily_rewards_count', 'weekly_rewards_count', 'last_updated'
      ];
      
      const csvRows = [this.arrayToCsvRow(headers)];
      
      devices.forEach(device => {
        const row = [
          device.miner_key,
          device.total_pending || 0,
          device.total_claimable || 0,
          device.total_claimed || 0,
          device.reward_count || 0,
          device.weekly_reward_count || 0,
          device.first_reward_date?.toISOString() || '',
          device.last_reward_date?.toISOString() || '',
          device.daily_rewards?.length || 0,
          device.weekly_rewards?.length || 0,
          device.last_updated?.toISOString() || ''
        ];
        csvRows.push(this.arrayToCsvRow(row));
      });
      
      await fs.writeFile(filename, csvRows.join('\n'));
      return filename;
      
    } catch (error) {
      console.error('Failed to backup device rewards:', error);
      return null;
    }
  }

  private async backupDevices(date: Date): Promise<string | null> {
    try {
      const Model = this.testMode ? TestDeviceModel : DeviceModel;
      const devices = await Model.find({ is_registered: true }).lean();
      
      if (devices.length === 0) return null;
      
      const filename = this.getBackupFileName(date, 'devices');
      const headers = [
        'miner_key', 'reward_wallet', 'verified', 'is_registered', 'byod',
        'created_at', 'staked_type', 'staked_amount', 'staked_time',
        'registration_amount', 'registration_time', 'node_amount', 'node_time'
      ];
      
      const csvRows = [this.arrayToCsvRow(headers)];
      
      devices.forEach(device => {
        const row = [
          device.miner_key,
          device.reward_wallet || '',
          device.verified || false,
          device.is_registered || false,
          Array.isArray(device.byod) ? device.byod.join(';') : '',
          device.created_at?.toISOString() || '',
          device.staked?.type || '',
          device.staked?.amount || 0,
          device.staked?.time?.toISOString() || '',
          device.registration?.amount || 0,
          device.registration?.time?.toISOString() || '',
          device.node?.amount || 0,
          device.node?.time?.toISOString() || ''
        ];
        csvRows.push(this.arrayToCsvRow(row));
      });
      
      await fs.writeFile(filename, csvRows.join('\n'));
      return filename;
      
    } catch (error) {
      console.error('Failed to backup devices:', error);
      return null;
    }
  }

  private async backupProducts(date: Date): Promise<string | null> {
    try {
      const products = await ProductModel.find({}).lean();
      
      if (products.length === 0) return null;
      
      const filename = this.getBackupFileName(date, 'products');
      const headers = [
        'key', 'name', 'verified_reward', 'reward_token',
        'register_token', 'node_token', 'register_stake', 'node_stake'
      ];
      
      const csvRows = [this.arrayToCsvRow(headers)];
      
      products.forEach(product => {
        const row = [
          product.key,
          product.name,
          product.reward?.verified || 0,
          product.reward?.tokens?.reward || '',
          product.reward?.tokens?.register || '',
          product.reward?.tokens?.node || '',
          product.reward?.stake?.register || 0,
          product.reward?.stake?.node || 0
        ];
        csvRows.push(this.arrayToCsvRow(row));
      });
      
      await fs.writeFile(filename, csvRows.join('\n'));
      return filename;
      
    } catch (error) {
      console.error('Failed to backup products:', error);
      return null;
    }
  }

  public async validateBackup(date: Date): Promise<{
    valid: boolean;
    errors: string[];
    metadata?: BackupMetadata;
  }> {
    const errors: string[] = [];
    
    try {
      const metadataFile = this.getMetadataFileName(date);
      const metadataContent = await fs.readFile(metadataFile, 'utf8');
      const metadata: BackupMetadata = JSON.parse(metadataContent);
      
      // Check if all backup files exist
      for (const collection of metadata.collections) {
        const backupFile = this.getBackupFileName(date, collection);
        try {
          await fs.access(backupFile);
        } catch {
          errors.push(`Missing backup file for ${collection}`);
        }
      }
      
      // Validate file integrity if no missing files
      if (errors.length === 0) {
        const currentHashes: string[] = [];
        for (const collection of metadata.collections) {
          const backupFile = this.getBackupFileName(date, collection);
          const hash = await this.calculateFileHash(backupFile);
          currentHashes.push(hash);
        }
        
        const currentIntegrity = currentHashes.join('-');
        if (currentIntegrity !== metadata.integrity) {
          errors.push('Backup integrity check failed - files may be corrupted');
        }
      }
      
      return {
        valid: errors.length === 0,
        errors,
        metadata
      };
      
    } catch (error) {
      errors.push(`Failed to validate backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { valid: false, errors };
    }
  }

  public async listBackups(): Promise<Array<{
    date: string;
    valid: boolean;
    metadata?: BackupMetadata;
    files: string[];
  }>> {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupDates = new Set<string>();
      
      // Extract unique dates from filenames
      files.forEach(file => {
        if (file.startsWith('metadata-') && file.endsWith('.json')) {
          const date = file.substring(9, 19); // Extract YYYY-MM-DD
          backupDates.add(date);
        }
      });
      
      const backups = [];
      for (const dateStr of Array.from(backupDates).sort().reverse()) {
        const date = new Date(dateStr);
        const validation = await this.validateBackup(date);
        const backupFiles = validation.metadata?.collections.map(col => 
          this.getBackupFileName(date, col)
        ) || [];
        
        backups.push({
          date: dateStr,
          valid: validation.valid,
          metadata: validation.metadata,
          files: backupFiles
        });
      }
      
      return backups;
      
    } catch (error) {
      console.error('Failed to list backups:', error);
      return [];
    }
  }

  private scheduleCleanup(): void {
    // Clean up old backups every 72 hours
    setInterval(async () => {
      await this.cleanupOldBackups();
    }, 72 * 60 * 60 * 1000);
    
    // Initial cleanup
    this.cleanupOldBackups().catch(console.error);
  }

  private async cleanupOldBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.backupDir);
      const cutoffDate = new Date(getSimNow().getTime() - this.retentionDays * 72 * 60 * 60 * 1000);
      
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime < cutoffDate) {
          await fs.unlink(filePath);
          console.log(`🗑️  Cleaned up old backup: ${file}`);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old backups:', error);
    }
  }

  // Schedule daily backup at 3 AM
  public startDailyBackups(): void {
    const checkAndBackup = async () => {
      const now = getSimNow();
      const hour = now.getHours();
      
      // Run at 3:00 AM daily
      if (hour === 3) {
        const dateStr = now.toISOString().split('T')[0];
        const expectedMetadataFile = this.getMetadataFileName(now);
        
        try {
          await fs.access(expectedMetadataFile);
          // Backup already exists for today
        } catch {
          // No backup for today, create one
          await this.createDailyBackup();
        }
      }
    };
    
    // Check every hour
    setInterval(checkAndBackup, 60 * 60 * 1000);
    
    // Initial check
    checkAndBackup().catch(console.error);
    
    console.log('📋 Daily backup scheduler started (3:00 AM)');
  }
}

// Singleton instance
export const backupManager = new BackupManager();
