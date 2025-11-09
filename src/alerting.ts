import "dotenv/config";
import { healthCheck } from "./health-check";
import { dbPerformanceMonitor } from "./performance-monitor";

interface AlertConfig {
  discordWebhook?: string;
  enabled: boolean;
  criticalThresholds: {
    maxFailureRate: number; // percentage
    maxProcessingTime: number; // minutes
    maxSlowQueryRate: number; // percentage
    maxErrorRate: number; // percentage
  };
}

interface Alert {
  level: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  message: string;
  timestamp: Date;
  data?: any;
}

class AlertingSystem {
  private config: AlertConfig;
  private lastAlerts: Map<string, Date> = new Map();
  private alertCooldown = 15 * 60 * 1000; // 15 minutes cooldown
  private minSlowQuerySample = parseInt(process.env.ALERT_MIN_SLOW_QUERY_SAMPLE || '20', 10);

  constructor() {
    this.config = {
      enabled: process.env.ALERTS_ENABLED === 'true',
      discordWebhook: process.env.DISCORD_WEBHOOK_URL,
      criticalThresholds: {
        maxFailureRate: parseFloat(process.env.ALERT_MAX_FAILURE_RATE || '20'), // 20%
        maxProcessingTime: parseFloat(process.env.ALERT_MAX_PROCESSING_TIME || '45'), // 45 minutes
        maxSlowQueryRate: parseFloat(process.env.ALERT_MAX_SLOW_QUERY_RATE || '15'), // 15%
        maxErrorRate: parseFloat(process.env.ALERT_MAX_ERROR_RATE || '5'), // 5%
      }
    };
  }

  async checkSystemHealth(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const health = await healthCheck();
      const dbStats = dbPerformanceMonitor.getStats();

      // Check for critical issues
      await this.checkCriticalIssues(health, dbStats);

      // Check for warnings
      await this.checkWarningConditions(health, dbStats);

    } catch (error) {
      await this.sendAlert({
        level: 'CRITICAL',
        title: 'Health Check Failed',
        message: `System health check failed: ${error}`,
        timestamp: new Date(),
        data: { error: String(error) }
      });
    }
  }

  private async checkCriticalIssues(health: any, dbStats: any): Promise<void> {
    const alerts: Alert[] = [];

    // System status is critical
    if (health.system_status === 'CRITICAL') {
      alerts.push({
        level: 'CRITICAL',
        title: 'System Status Critical',
        message: `dbRewards system status is CRITICAL. Issues: ${health.issues.join(', ')}`,
        timestamp: new Date(),
        data: health
      });
    }

    // No rewards generated today (after hour 2)
    if (health.current_hour > 2 && health.todays_rewards === 0) {
      alerts.push({
        level: 'CRITICAL',
        title: 'No Rewards Generated',
        message: `No rewards have been generated today after hour ${health.current_hour}`,
        timestamp: new Date(),
        data: { current_hour: health.current_hour, todays_rewards: health.todays_rewards }
      });
    }

    // High database error rate
    const errorRate = dbStats.totalQueries > 0 ? (dbStats.errorCount / dbStats.totalQueries * 100) : 0;
    if (errorRate > this.config.criticalThresholds.maxErrorRate) {
      alerts.push({
        level: 'CRITICAL',
        title: 'High Database Error Rate',
        message: `Database error rate is ${errorRate.toFixed(1)}% (threshold: ${this.config.criticalThresholds.maxErrorRate}%)`,
        timestamp: new Date(),
        data: { errorRate, threshold: this.config.criticalThresholds.maxErrorRate, dbStats }
      });
    }

    // Very slow processing time (if we have processing metrics)
    // This would need to be integrated with actual processing metrics from main.ts

    // Send all critical alerts
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }
  }

  private async checkWarningConditions(health: any, dbStats: any): Promise<void> {
    const alerts: Alert[] = [];

    // System status is warning
    if (health.system_status === 'WARNING') {
      alerts.push({
        level: 'WARNING',
        title: 'System Status Warning',
        message: `dbRewards system status is WARNING. Issues: ${health.issues.join(', ')}`,
        timestamp: new Date(),
        data: health
      });
    }

    // Behind on hourly processing
    const expectedRewards = health.expected_rewards_by_now ?? (health.expected_hourly_devices * Math.max(health.hours_processed_today, 1));
    const effectiveHours = health.effective_hours_for_expectations ?? health.hours_processed_today;
    const laggingHours = Math.max(0, (health.hours_expected_so_far ?? 0) - health.hours_processed_today);
    const completionRate = expectedRewards > 0 ? (health.todays_rewards / expectedRewards) * 100 : 100;
    if (completionRate < 80 && effectiveHours > 0 && laggingHours >= 2) {
      alerts.push({
        level: 'WARNING',
        title: 'Behind on Processing',
        message: `Processing is behind schedule: ${health.todays_rewards}/${expectedRewards} expected rewards (${completionRate.toFixed(1)}%)`,
        timestamp: new Date(),
        data: { completion_rate: completionRate, todays_rewards: health.todays_rewards, expected: expectedRewards }
      });
    }

    // High slow query rate
    const slowQueryRate = dbStats.totalQueries > 0 ? (dbStats.slowQueries / dbStats.totalQueries * 100) : 0;
    if (
      dbStats.totalQueries >= this.minSlowQuerySample &&
      slowQueryRate > this.config.criticalThresholds.maxSlowQueryRate
    ) {
      alerts.push({
        level: 'WARNING',
        title: 'High Slow Query Rate',
        message: `Slow query rate is ${slowQueryRate.toFixed(1)}% (threshold: ${this.config.criticalThresholds.maxSlowQueryRate}%)`,
        timestamp: new Date(),
        data: { slowQueryRate, threshold: this.config.criticalThresholds.maxSlowQueryRate }
      });
    }

    // Send all warning alerts
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }
  }

  private async sendAlert(alert: Alert): Promise<void> {
    const alertKey = `${alert.level}-${alert.title}`;
    const lastAlert = this.lastAlerts.get(alertKey);
    
    // Check cooldown to prevent spam
    if (lastAlert && (Date.now() - lastAlert.getTime()) < this.alertCooldown) {
      return;
    }

    console.log(`🚨 ALERT [${alert.level}]: ${alert.title}`);
    console.log(`   Message: ${alert.message}`);
    console.log(`   Time: ${alert.timestamp.toISOString()}`);

    // Update last alert time
    this.lastAlerts.set(alertKey, alert.timestamp);

    // Send to Discord if webhook is configured
    if (this.config.discordWebhook) {
      try {
        await this.sendDiscordAlert(alert);
      } catch (error) {
        console.error('Failed to send Discord alert:', error);
      }
    }
  }

  private async sendDiscordAlert(alert: Alert): Promise<void> {
    if (!this.config.discordWebhook) return;

    const color = alert.level === 'CRITICAL' ? 15158332 : // Red
                  alert.level === 'WARNING' ? 16776960 :  // Yellow
                  65280; // Green

    const emoji = alert.level === 'CRITICAL' ? '🚨' : 
                  alert.level === 'WARNING' ? '⚠️' : 'ℹ️';

    const environment = process.env.TEST_MODE === 'true' ? 'TEST' : 'PRODUCTION';

    try {
      const response = await fetch(this.config.discordWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: `${emoji} **dbRewards Alert [${alert.level}]**`,
          embeds: [{
            title: alert.title,
            description: alert.message,
            color: color,
            timestamp: alert.timestamp.toISOString(),
            footer: {
              text: `dbRewards ${environment}`
            },
            fields: alert.data ? [
              {
                name: 'Additional Data',
                value: `\`\`\`json\n${JSON.stringify(alert.data, null, 2).slice(0, 1000)}\`\`\``,
                inline: false
              }
            ] : []
          }]
        }),
      });

      if (!response.ok) {
        throw new Error(`Discord webhook request failed: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to send Discord alert:', error);
    }
  }

  // Convenience hook for subsystems that need to push structured alerts (optionally forcing delivery)
  async emit(
    level: Alert['level'],
    title: string,
    message: string,
    data?: Record<string, unknown> | unknown,
    options?: { force?: boolean },
  ): Promise<void> {
    if (!this.config.enabled && !options?.force) {
      return;
    }
    await this.sendAlert({
      level,
      title,
      message,
      timestamp: new Date(),
      data,
    });
  }

  // Method to manually trigger an alert (for testing)
  async sendTestAlert(): Promise<void> {
    await this.emit(
      'INFO',
      'Test Alert',
      'This is a test alert from the dbRewards monitoring system',
      { test: true },
    );
  }

  // Get alerting configuration status
  getConfig(): AlertConfig {
    return { ...this.config };
  }

  // Update alert thresholds
  updateThresholds(newThresholds: Partial<AlertConfig['criticalThresholds']>): void {
    this.config.criticalThresholds = {
      ...this.config.criticalThresholds,
      ...newThresholds
    };
  }
}

// Create global instance
export const alertingSystem = new AlertingSystem();

// Function to run periodic health checks with alerting
export async function runPeriodicHealthCheck(): Promise<void> {
  try {
    await alertingSystem.checkSystemHealth();
  } catch (error) {
    console.error('Periodic health check failed:', error);
  }
}

// Schedule periodic health checks (every 10 minutes)
export function startPeriodicHealthChecks(): void {
  if (process.env.ALERTS_ENABLED === 'true') {
    console.log('� Starting periodic health checks with alerting');
    
    // Run immediately
    runPeriodicHealthCheck();
    
    // Then run every 10 minutes
    setInterval(runPeriodicHealthCheck, 10 * 60 * 1000);
  } else {
    console.log('🔕 Alerting system is disabled');
  }
}

export { AlertingSystem, Alert, AlertConfig };
