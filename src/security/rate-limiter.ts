import { getSimNow } from '../time-control';

// Define default configs and a static key type we can use in annotations
const defaultConfigs = {
  admin: { windowMs: 15 * 60 * 1000, maxRequests: 30 }, // 30 requests per 15 minutes
  auth: { windowMs: 15 * 60 * 1000, maxRequests: 5 },   // 5 auth attempts per 15 minutes
  api: { windowMs: 60 * 1000, maxRequests: 100 },       // 100 requests per minute
  metrics: { windowMs: 60 * 1000, maxRequests: 20 }     // 20 metrics requests per minute
} as const;
export type RateLimitType = keyof typeof defaultConfigs;

interface RateLimitEntry {
  count: number;
  resetTime: Date;
  firstRequest: Date;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;
  
  // Different limits for different endpoint types
  private readonly configs: Record<RateLimitType, RateLimitConfig> = { ...defaultConfigs };

  constructor() {
    // Clean up expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  private cleanup(): void {
    const now = getSimNow();
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetTime) {
        this.entries.delete(key);
      }
    }
  }

  private getKey(identifier: string, type: RateLimitType): string {
    return `${type}:${identifier}`;
  }

  public checkLimit(
    identifier: string, 
    type: RateLimitType
  ): { 
    allowed: boolean; 
    remaining: number; 
    resetTime: Date; 
    retryAfter?: number 
  } {
    const config = this.configs[type];
    const key = this.getKey(identifier, type);
    const now = getSimNow();
    
    let entry = this.entries.get(key);
    
    // Create new entry or reset if window expired
    if (!entry || now >= entry.resetTime) {
      entry = {
        count: 0,
        resetTime: new Date(now.getTime() + config.windowMs),
        firstRequest: now
      };
      this.entries.set(key, entry);
    }
    
    // Check if limit exceeded
    if (entry.count >= config.maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime.getTime() - now.getTime()) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
        retryAfter
      };
    }
    
    // Increment counter
    entry.count++;
    
    return {
      allowed: true,
      remaining: config.maxRequests - entry.count,
      resetTime: entry.resetTime
    };
  }

  public getStats(): {
    activeEntries: number;
    totalRequests: number;
    blockedRequests: number;
  } {
    let totalRequests = 0;
    let blockedRequests = 0;
    
    for (const [key, entry] of this.entries) {
      totalRequests += entry.count;
      const [type] = key.split(':');
      const config = this.configs[type as RateLimitType];
      if (config && entry.count >= config.maxRequests) {
        blockedRequests++;
      }
    }
    
    return {
      activeEntries: this.entries.size,
      totalRequests,
      blockedRequests
    };
  }

  public getTopOffenders(limit: number = 10): Array<{
    identifier: string;
    type: string;
    count: number;
    firstRequest: Date;
    resetTime: Date;
  }> {
    const entries = Array.from(this.entries.entries())
      .map(([key, entry]) => {
        const [type, identifier] = key.split(':');
        return {
          identifier,
          type,
          count: entry.count,
          firstRequest: entry.firstRequest,
          resetTime: entry.resetTime
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
      
    return entries;
  }

  public getConfig(type: RateLimitType): RateLimitConfig {
    return { ...this.configs[type] };
  }

  public reset(identifier?: string, type?: RateLimitType): void {
    if (identifier && type) {
      // Reset specific entry
      const key = this.getKey(identifier, type);
      this.entries.delete(key);
    } else {
      // Reset all entries
      this.entries.clear();
    }
  }

  public destroy(): void {
    clearInterval(this.cleanupInterval);
    this.entries.clear();
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

// Express middleware factory
export function createRateLimitMiddleware(type: 'admin' | 'auth' | 'api' | 'metrics') {
  return (req: any, res: any, next: any) => {
    const identifier = req.ip || req.connection.remoteAddress || 'unknown';
    const result = rateLimiter.checkLimit(identifier, type);
    const config = rateLimiter.getConfig(type);
    
    // Set rate limit headers
    res.set({
      'X-RateLimit-Limit': config.maxRequests,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': result.resetTime.toISOString()
    });
    
    if (!result.allowed) {
      res.set('Retry-After', result.retryAfter?.toString() || '900');
      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded',
        retryAfter: result.retryAfter
      });
    }
    
    next();
  };
}
