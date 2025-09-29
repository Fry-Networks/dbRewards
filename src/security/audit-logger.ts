import fs from 'fs/promises';
import path from 'path';
import { getSimNow } from '../time-control';

export interface AuditEvent {
  timestamp: Date;
  eventType: 'AUTH_SUCCESS' | 'AUTH_FAILURE' | 'ADMIN_ACTION' | 'TOKEN_ROTATION' | 'RATE_LIMIT_HIT' | 'SECURITY_VIOLATION';
  userId?: string;
  ipAddress: string;
  userAgent?: string;
  endpoint?: string;
  action?: string;
  details?: any;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sessionId?: string;
}

export interface AuditLogSummary {
  totalEvents: number;
  authFailures: number;
  securityViolations: number;
  uniqueIPs: number;
  timeRange: {
    start: Date;
    end: Date;
  };
}

export class AuditLogger {
  private readonly logDir = path.join(process.cwd(), '.logs', 'audit');
  private readonly maxLogFileSize = 10 * 1024 * 1024; // 10MB
  private readonly retentionDays = 90; // Keep logs for 90 days
  
  constructor() {
    this.ensureLogDirectory();
    this.scheduleCleanup();
  }

  private async ensureLogDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create audit log directory:', error);
    }
  }

  private getLogFileName(date: Date = getSimNow()): string {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logDir, `audit-${dateStr}.jsonl`);
  }

  public async logEvent(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    const auditEvent: AuditEvent = {
      ...event,
      timestamp: getSimNow()
    };

    const logEntry = JSON.stringify(auditEvent) + '\n';
    const logFile = this.getLogFileName(auditEvent.timestamp);

    try {
      await fs.appendFile(logFile, logEntry);
      
      // Log to console for immediate visibility of critical events
      if (auditEvent.severity === 'CRITICAL' || auditEvent.severity === 'HIGH') {
        console.log(`🚨 AUDIT [${auditEvent.severity}]: ${auditEvent.eventType} - ${auditEvent.action || 'N/A'} from ${auditEvent.ipAddress}`);
      }

      // Check file size and rotate if needed
      await this.checkAndRotateLog(logFile);
    } catch (error) {
      console.error('Failed to write audit log:', error);
    }
  }

  private async checkAndRotateLog(logFile: string): Promise<void> {
    try {
      const stats = await fs.stat(logFile);
      if (stats.size > this.maxLogFileSize) {
        const timestamp = getSimNow().toISOString().replace(/[:.]/g, '-');
        const rotatedFile = logFile.replace('.jsonl', `-${timestamp}.jsonl`);
        await fs.rename(logFile, rotatedFile);
        console.log(`📋 Rotated audit log: ${path.basename(rotatedFile)}`);
      }
    } catch (error) {
      // File might not exist yet, which is fine
    }
  }

  public async getEventsForDate(date: Date): Promise<AuditEvent[]> {
    const logFile = this.getLogFileName(date);
    try {
      const content = await fs.readFile(logFile, 'utf8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const event = JSON.parse(line);
          event.timestamp = new Date(event.timestamp);
          return event;
        });
    } catch (error) {
      return [];
    }
  }

  public async getEventsSince(since: Date): Promise<AuditEvent[]> {
    const now = getSimNow();
    const events: AuditEvent[] = [];
    
    // Check each day from 'since' to now
    for (let d = new Date(since); d <= now; d.setDate(d.getDate() + 1)) {
      const dayEvents = await this.getEventsForDate(d);
      events.push(...dayEvents.filter(event => event.timestamp >= since));
    }
    
    return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  public async getSummary(hours: number = 24): Promise<AuditLogSummary> {
    const since = new Date(getSimNow().getTime() - hours * 60 * 60 * 1000);
    const events = await this.getEventsSince(since);
    
    const uniqueIPs = new Set(events.map(e => e.ipAddress)).size;
    const authFailures = events.filter(e => e.eventType === 'AUTH_FAILURE').length;
    const securityViolations = events.filter(e => e.eventType === 'SECURITY_VIOLATION').length;
    
    return {
      totalEvents: events.length,
      authFailures,
      securityViolations,
      uniqueIPs,
      timeRange: {
        start: since,
        end: getSimNow()
      }
    };
  }

  public async getSecurityAlerts(hours: number = 24): Promise<AuditEvent[]> {
    const events = await this.getEventsSince(new Date(getSimNow().getTime() - hours * 60 * 60 * 1000));
    return events.filter(event => 
      event.severity === 'HIGH' || 
      event.severity === 'CRITICAL' ||
      event.eventType === 'SECURITY_VIOLATION' ||
      event.eventType === 'RATE_LIMIT_HIT'
    );
  }

  public async detectSuspiciousActivity(): Promise<{
    suspiciousIPs: string[];
    rateLimitAbusers: string[];
    authFailureSpikes: any[];
  }> {
    const events = await this.getEventsSince(new Date(getSimNow().getTime() - 24 * 60 * 60 * 1000));
    
    // Group events by IP
    const ipActivity = new Map<string, AuditEvent[]>();
    events.forEach(event => {
      if (!ipActivity.has(event.ipAddress)) {
        ipActivity.set(event.ipAddress, []);
      }
      ipActivity.get(event.ipAddress)!.push(event);
    });

    // Detect suspicious IPs (high failure rate)
    const suspiciousIPs: string[] = [];
    const rateLimitAbusers: string[] = [];
    
    ipActivity.forEach((ipEvents, ip) => {
      const authFailures = ipEvents.filter(e => e.eventType === 'AUTH_FAILURE').length;
      const totalRequests = ipEvents.length;
      const rateLimitHits = ipEvents.filter(e => e.eventType === 'RATE_LIMIT_HIT').length;
      
      // Flag IPs with >50% auth failure rate and >5 attempts
      if (authFailures > 5 && (authFailures / totalRequests) > 0.5) {
        suspiciousIPs.push(ip);
      }
      
      // Flag IPs hitting rate limits frequently
      if (rateLimitHits > 10) {
        rateLimitAbusers.push(ip);
      }
    });

    // Detect auth failure spikes (simplified)
    const authFailureSpikes = events
      .filter(e => e.eventType === 'AUTH_FAILURE')
      .reduce((acc: any[], event) => {
        const hour = new Date(event.timestamp).getHours();
        const existing = acc.find(spike => spike.hour === hour);
        if (existing) {
          existing.count++;
        } else {
          acc.push({ hour, count: 1 });
        }
        return acc;
      }, [])
      .filter(spike => spike.count > 10); // More than 10 failures in an hour

    return {
      suspiciousIPs,
      rateLimitAbusers,
      authFailureSpikes
    };
  }

  private scheduleCleanup(): void {
    // Clean up old logs every 24 hours
    setInterval(async () => {
      await this.cleanupOldLogs();
    }, 24 * 60 * 60 * 1000);
    
    // Initial cleanup
    this.cleanupOldLogs().catch(console.error);
  }

  private async cleanupOldLogs(): Promise<void> {
    try {
      const files = await fs.readdir(this.logDir);
      const cutoffDate = new Date(getSimNow().getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        if (file.startsWith('audit-') && file.endsWith('.jsonl')) {
          const filePath = path.join(this.logDir, file);
          const stats = await fs.stat(filePath);
          
          if (stats.mtime < cutoffDate) {
            await fs.unlink(filePath);
            console.log(`🗑️  Cleaned up old audit log: ${file}`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old audit logs:', error);
    }
  }

  // Helper methods for common logging scenarios
  public async logAuthSuccess(ipAddress: string, userAgent?: string, endpoint?: string): Promise<void> {
    await this.logEvent({
      eventType: 'AUTH_SUCCESS',
      ipAddress,
      userAgent,
      endpoint,
      severity: 'LOW',
      action: 'Admin authentication successful'
    });
  }

  public async logAuthFailure(ipAddress: string, reason: string, userAgent?: string, endpoint?: string): Promise<void> {
    await this.logEvent({
      eventType: 'AUTH_FAILURE',
      ipAddress,
      userAgent,
      endpoint,
      severity: 'MEDIUM',
      action: 'Admin authentication failed',
      details: { reason }
    });
  }

  public async logAdminAction(ipAddress: string, action: string, endpoint: string, details?: any, userAgent?: string): Promise<void> {
    await this.logEvent({
      eventType: 'ADMIN_ACTION',
      ipAddress,
      userAgent,
      endpoint,
      action,
      details,
      severity: 'MEDIUM'
    });
  }

  public async logTokenRotation(details?: any): Promise<void> {
    await this.logEvent({
      eventType: 'TOKEN_ROTATION',
      ipAddress: 'system',
      action: 'Admin token rotated',
      details,
      severity: 'LOW'
    });
  }

  public async logRateLimitHit(ipAddress: string, endpoint: string, userAgent?: string): Promise<void> {
    await this.logEvent({
      eventType: 'RATE_LIMIT_HIT',
      ipAddress,
      userAgent,
      endpoint,
      action: 'Rate limit exceeded',
      severity: 'MEDIUM'
    });
  }

  public async logSecurityViolation(ipAddress: string, violation: string, details?: any, userAgent?: string): Promise<void> {
    await this.logEvent({
      eventType: 'SECURITY_VIOLATION',
      ipAddress,
      userAgent,
      action: violation,
      details,
      severity: 'HIGH'
    });
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();
