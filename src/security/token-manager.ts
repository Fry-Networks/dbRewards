import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getSimNow } from '../time-control';

interface TokenData {
  token: string;
  createdAt: Date;
  expiresAt: Date;
  weekNumber: number;
  isActive: boolean;
}

interface TokenStore {
  current: TokenData | null;
  previous: TokenData | null;
  rotationHistory: TokenData[];
}

export class TokenManager {
  private tokenStore: TokenStore = {
    current: null,
    previous: null,
    rotationHistory: []
  };
  
  private readonly tokenFilePath = path.join(process.cwd(), '.tokens', 'admin-tokens.json');
  private readonly maxHistorySize = 12; // Keep 12 weeks of history
  
  constructor() {
    this.ensureTokenDirectory();
    this.loadTokenStore();
  }

  private async ensureTokenDirectory(): Promise<void> {
    const tokenDir = path.dirname(this.tokenFilePath);
    try {
      await fs.mkdir(tokenDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create token directory:', error);
    }
  }

  private async loadTokenStore(): Promise<void> {
    try {
      const data = await fs.readFile(this.tokenFilePath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Convert date strings back to Date objects
      if (parsed.current) {
        parsed.current.createdAt = new Date(parsed.current.createdAt);
        parsed.current.expiresAt = new Date(parsed.current.expiresAt);
      }
      if (parsed.previous) {
        parsed.previous.createdAt = new Date(parsed.previous.createdAt);
        parsed.previous.expiresAt = new Date(parsed.previous.expiresAt);
      }
      parsed.rotationHistory = parsed.rotationHistory.map((token: any) => ({
        ...token,
        createdAt: new Date(token.createdAt),
        expiresAt: new Date(token.expiresAt)
      }));
      
      this.tokenStore = parsed;
      
      // Check if current token needs rotation
      await this.checkAndRotateToken();
    } catch (error) {
      console.log('No existing token store found, creating new one');
      await this.generateInitialToken();
    }
  }

  private async saveTokenStore(): Promise<void> {
    try {
      await fs.writeFile(this.tokenFilePath, JSON.stringify(this.tokenStore, null, 2));
      // Set restrictive permissions on token file
      await fs.chmod(this.tokenFilePath, 0o600);
    } catch (error) {
      console.error('Failed to save token store:', error);
    }
  }

  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private getWeekNumber(date: Date): number {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date.getTime() - startOfYear.getTime()) / 86400000;
    return Math.ceil((pastDaysOfYear + startOfYear.getDay() + 1) / 7);
  }

  private async generateInitialToken(): Promise<void> {
    const now = getSimNow();
    const weekNumber = this.getWeekNumber(now);
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    this.tokenStore.current = {
      token: this.generateSecureToken(),
      createdAt: now,
      expiresAt,
      weekNumber,
      isActive: true
    };

    await this.saveTokenStore();
    console.log(`🔐 Generated initial admin token for week ${weekNumber}`);
  }

  public async checkAndRotateToken(): Promise<boolean> {
    const now = getSimNow();
    const currentWeek = this.getWeekNumber(now);
    
    if (!this.tokenStore.current) {
      await this.generateInitialToken();
      return true;
    }

    // Check if token has expired or if we're in a new week
    const needsRotation = 
      now >= this.tokenStore.current.expiresAt || 
      currentWeek !== this.tokenStore.current.weekNumber;

    if (needsRotation) {
      await this.rotateToken();
      return true;
    }

    return false;
  }

  private async rotateToken(): Promise<void> {
    const now = getSimNow();
    const weekNumber = this.getWeekNumber(now);
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Move current to previous
    if (this.tokenStore.current) {
      this.tokenStore.current.isActive = false;
      this.tokenStore.previous = this.tokenStore.current;
      
      // Add to history
      this.tokenStore.rotationHistory.unshift(this.tokenStore.current);
      
      // Trim history to max size
      if (this.tokenStore.rotationHistory.length > this.maxHistorySize) {
        this.tokenStore.rotationHistory = this.tokenStore.rotationHistory.slice(0, this.maxHistorySize);
      }
    }

    // Generate new current token
    this.tokenStore.current = {
      token: this.generateSecureToken(),
      createdAt: now,
      expiresAt,
      weekNumber,
      isActive: true
    };

    await this.saveTokenStore();
    
    console.log(`🔄 Rotated admin token for week ${weekNumber}`);
    console.log(`📅 New token expires: ${expiresAt.toISOString()}`);
    
    // Schedule notification for upcoming rotation
    this.scheduleRotationNotification();
  }

  private scheduleRotationNotification(): void {
    if (!this.tokenStore.current) return;
    
    const timeUntilExpiry = this.tokenStore.current.expiresAt.getTime() - getSimNow().getTime();
    const notificationTime = Math.max(0, timeUntilExpiry - 24 * 60 * 60 * 1000); // 24 hours before
    
    setTimeout(() => {
      console.log('⚠️  Admin token will expire in 24 hours');
    }, notificationTime);
  }

  public isValidToken(providedToken: string): boolean {
    if (!providedToken) return false;

    // Check current token
    if (this.tokenStore.current?.isActive && this.tokenStore.current.token === providedToken) {
      const now = getSimNow();
      return now < this.tokenStore.current.expiresAt;
    }

    // Check previous token (grace period for rotation)
    if (this.tokenStore.previous?.token === providedToken) {
      const now = getSimNow();
      const gracePeriod = 15 * 60 * 1000; // 15 minutes grace period
      return now < new Date(this.tokenStore.previous.expiresAt.getTime() + gracePeriod);
    }

    return false;
  }

  public getCurrentToken(): string | null {
    return this.tokenStore.current?.token || null;
  }

  public getTokenInfo(): {
    hasToken: boolean;
    expiresAt: Date | null;
    weekNumber: number | null;
    timeUntilExpiry: number | null;
  } {
    if (!this.tokenStore.current) {
      return {
        hasToken: false,
        expiresAt: null,
        weekNumber: null,
        timeUntilExpiry: null
      };
    }

    const now = getSimNow();
    return {
      hasToken: true,
      expiresAt: this.tokenStore.current.expiresAt,
      weekNumber: this.tokenStore.current.weekNumber,
      timeUntilExpiry: this.tokenStore.current.expiresAt.getTime() - now.getTime()
    };
  }

  public getRotationHistory(): TokenData[] {
    return [...this.tokenStore.rotationHistory];
  }

  // Force rotation for testing/emergency
  public async forceRotation(): Promise<void> {
    await this.rotateToken();
  }
}

// Singleton instance
export const tokenManager = new TokenManager();
