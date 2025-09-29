import "dotenv/config";

interface QueryMetrics {
  operation: string;
  collection: string;
  duration: number;
  timestamp: Date;
  success: boolean;
  error?: string;
}

interface PerformanceStats {
  totalQueries: number;
  totalDuration: number;
  averageDuration: number;
  slowQueries: number;
  errorCount: number;
  lastReset: Date;
}

class PerformanceMonitor {
  private metrics: QueryMetrics[] = [];
  private slowQueryThreshold: number;
  private maxMetricsHistory: number;
  private stats: PerformanceStats;

  constructor(slowQueryThreshold = 1000, maxMetricsHistory = 1000) {
    this.slowQueryThreshold = slowQueryThreshold; // ms
    this.maxMetricsHistory = maxMetricsHistory;
    this.stats = {
      totalQueries: 0,
      totalDuration: 0,
      averageDuration: 0,
      slowQueries: 0,
      errorCount: 0,
      lastReset: new Date()
    };
  }

  // Wrapper function to monitor database operations
  async monitorQuery<T>(
    operation: string,
    collection: string,
    queryFn: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    let success = true;
    let error: string | undefined;

    try {
      const result = await queryFn();
      return result;
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const duration = Date.now() - startTime;
      this.recordMetric({
        operation,
        collection,
        duration,
        timestamp: new Date(),
        success,
        error
      });
    }
  }

  private recordMetric(metric: QueryMetrics): void {
    // Add to metrics history
    this.metrics.push(metric);
    
    // Keep only recent metrics to prevent memory bloat
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics = this.metrics.slice(-this.maxMetricsHistory);
    }

    // Update stats
    this.stats.totalQueries++;
    this.stats.totalDuration += metric.duration;
    this.stats.averageDuration = this.stats.totalDuration / this.stats.totalQueries;

    if (!metric.success) {
      this.stats.errorCount++;
    }

    if (metric.duration >= this.slowQueryThreshold) {
      this.stats.slowQueries++;
      this.logSlowQuery(metric);
    }

    // Log performance warnings
    if (metric.duration > this.slowQueryThreshold * 2) {
      console.warn(`🐌 Very slow query detected: ${metric.operation} on ${metric.collection} took ${metric.duration}ms`);
    }
  }

  private logSlowQuery(metric: QueryMetrics): void {
    console.warn(`🐌 Slow query: ${metric.operation} on ${metric.collection} took ${metric.duration}ms`);
    
    // Log additional details in debug mode
    if (process.env.DEBUG === 'true') {
      console.debug('Slow query details:', {
        operation: metric.operation,
        collection: metric.collection,
        duration: metric.duration,
        timestamp: metric.timestamp,
        threshold: this.slowQueryThreshold
      });
    }
  }

  // Get current performance statistics
  getStats(): PerformanceStats & { recentMetrics: QueryMetrics[] } {
    return {
      ...this.stats,
      recentMetrics: this.metrics.slice(-10) // Last 10 queries
    };
  }

  // Get slow queries from recent history
  getSlowQueries(limit = 10): QueryMetrics[] {
    return this.metrics
      .filter(m => m.duration >= this.slowQueryThreshold)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit);
  }

  // Get error queries from recent history
  getErrorQueries(limit = 10): QueryMetrics[] {
    return this.metrics
      .filter(m => !m.success)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  // Reset statistics
  resetStats(): void {
    this.stats = {
      totalQueries: 0,
      totalDuration: 0,
      averageDuration: 0,
      slowQueries: 0,
      errorCount: 0,
      lastReset: new Date()
    };
    this.metrics = [];
  }

  // Get performance summary for logging
  getPerformanceSummary(): string {
    const stats = this.getStats();
    const errorRate = stats.totalQueries > 0 ? (stats.errorCount / stats.totalQueries * 100).toFixed(2) : '0.00';
    const slowQueryRate = stats.totalQueries > 0 ? (stats.slowQueries / stats.totalQueries * 100).toFixed(2) : '0.00';
    
    return `DB Performance: ${stats.totalQueries} queries, avg ${stats.averageDuration.toFixed(1)}ms, ` +
           `${stats.slowQueries} slow (${slowQueryRate}%), ${stats.errorCount} errors (${errorRate}%)`;
  }

  // Check if performance is concerning
  isPerformanceConcerning(): boolean {
    const stats = this.getStats();
    const errorRate = stats.totalQueries > 0 ? (stats.errorCount / stats.totalQueries) : 0;
    const slowQueryRate = stats.totalQueries > 0 ? (stats.slowQueries / stats.totalQueries) : 0;
    
    return (
      stats.averageDuration > this.slowQueryThreshold / 2 || // Average query time over half the slow threshold
      errorRate > 0.05 || // More than 5% error rate
      slowQueryRate > 0.1 // More than 10% slow queries
    );
  }
}

// Create global instance
export const dbPerformanceMonitor = new PerformanceMonitor(1000, 500); // 1 second threshold, keep 500 metrics

// Helper function to wrap mongoose operations
export function withPerformanceMonitoring<T>(
  operation: string,
  collection: string,
  queryFn: () => Promise<T>
): Promise<T> {
  return dbPerformanceMonitor.monitorQuery(operation, collection, queryFn);
}

// Export types for external use
export { QueryMetrics, PerformanceStats };
