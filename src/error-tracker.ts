import "dotenv/config";

export enum ErrorCategory {
  DATABASE = 'DATABASE',
  NETWORK = 'NETWORK',
  VALIDATION = 'VALIDATION',
  ALGORAND = 'ALGORAND',
  PROCESSING = 'PROCESSING',
  AUTHENTICATION = 'AUTHENTICATION',
  CONFIGURATION = 'CONFIGURATION',
  UNKNOWN = 'UNKNOWN'
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface CategorizedError {
  id: string;
  timestamp: Date;
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  context: string;
  operation: string;
  deviceId?: string;
  error: string;
  stackTrace?: string;
  metadata?: any;
}

export interface ErrorStats {
  total: number;
  byCategory: Record<ErrorCategory, number>;
  bySeverity: Record<ErrorSeverity, number>;
  recent: CategorizedError[];
  trends: {
    lastHour: number;
    lastDay: number;
    lastWeek: number;
  };
}

class ErrorTracker {
  private errors: CategorizedError[] = [];
  private maxErrorHistory = 1000;
  private cleanupInterval?: NodeJS.Timeout;

  constructor() {
    // Don't start cleanup automatically - it will be started when initialize() is called
  }

  // Initialize the error tracker with periodic cleanup
  initialize(): void {
    if (this.cleanupInterval) {
      return; // Already initialized
    }

    // Clean up old errors periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldErrors();
    }, 60 * 60 * 1000); // Every hour
  }

  // Stop the periodic cleanup
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  categorizeError(error: any, context: string, operation: string): ErrorCategory {
    const errorMessage = error.message || error.toString().toLowerCase();
    const errorCode = error.code;

    // Database errors
    if (errorCode === 'ECONNREFUSED' || 
        errorMessage.includes('connection') ||
        errorMessage.includes('mongodb') ||
        errorMessage.includes('mongoose') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('duplicate key')) {
      return ErrorCategory.DATABASE;
    }

    // Network errors
    if (errorCode === 'ENOTFOUND' ||
        errorCode === 'ECONNRESET' ||
        errorMessage.includes('network') ||
        errorMessage.includes('fetch') ||
        errorMessage.includes('http') ||
        errorMessage.includes('request failed')) {
      return ErrorCategory.NETWORK;
    }

    // Validation errors
    if (errorMessage.includes('validation') ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('required') ||
        errorMessage.includes('missing') ||
        errorMessage.includes('not found') ||
        context.includes('validation')) {
      return ErrorCategory.VALIDATION;
    }

    // Algorand specific errors
    if (errorMessage.includes('algorand') ||
        errorMessage.includes('algod') ||
        errorMessage.includes('indexer') ||
        errorMessage.includes('transaction') ||
        context.includes('algorand')) {
      return ErrorCategory.ALGORAND;
    }

    // Authentication errors
    if (errorMessage.includes('unauthorized') ||
        errorMessage.includes('forbidden') ||
        errorMessage.includes('authentication') ||
        errorMessage.includes('token')) {
      return ErrorCategory.AUTHENTICATION;
    }

    // Configuration errors
    if (errorMessage.includes('config') ||
        errorMessage.includes('environment') ||
        errorMessage.includes('undefined') && context.includes('env')) {
      return ErrorCategory.CONFIGURATION;
    }

    // Processing errors
    if (context.includes('reward') ||
        context.includes('processing') ||
        context.includes('batch') ||
        operation.includes('process')) {
      return ErrorCategory.PROCESSING;
    }

    return ErrorCategory.UNKNOWN;
  }

  determineSeverity(error: any, category: ErrorCategory): ErrorSeverity {
    const errorMessage = error.message || error.toString().toLowerCase();

    // Critical severity conditions
    if (category === ErrorCategory.DATABASE && 
        (errorMessage.includes('connection refused') || errorMessage.includes('authentication failed'))) {
      return ErrorSeverity.CRITICAL;
    }

    if (category === ErrorCategory.CONFIGURATION && 
        (errorMessage.includes('required') || errorMessage.includes('undefined'))) {
      return ErrorSeverity.CRITICAL;
    }

    // High severity conditions
    if (category === ErrorCategory.PROCESSING && errorMessage.includes('failed')) {
      return ErrorSeverity.HIGH;
    }

    if (category === ErrorCategory.DATABASE && errorMessage.includes('timeout')) {
      return ErrorSeverity.HIGH;
    }

    // Medium severity conditions
    if (category === ErrorCategory.VALIDATION) {
      return ErrorSeverity.MEDIUM;
    }

    if (category === ErrorCategory.NETWORK && !errorMessage.includes('timeout')) {
      return ErrorSeverity.MEDIUM;
    }

    // Default to low severity
    return ErrorSeverity.LOW;
  }

  trackError(
    error: any, 
    context: string, 
    operation: string, 
    deviceId?: string, 
    metadata?: any
  ): string {
    const category = this.categorizeError(error, context, operation);
    const severity = this.determineSeverity(error, category);
    const errorId = this.generateErrorId();

    const categorizedError: CategorizedError = {
      id: errorId,
      timestamp: new Date(),
      category,
      severity,
      message: error.message || 'Unknown error',
      context,
      operation,
      deviceId,
      error: error.toString(),
      stackTrace: error.stack,
      metadata
    };

    this.errors.push(categorizedError);

    // Keep only recent errors to prevent memory bloat
    if (this.errors.length > this.maxErrorHistory) {
      this.errors = this.errors.slice(-this.maxErrorHistory);
    }

    // Log error with category and severity
    const logLevel = severity === ErrorSeverity.CRITICAL ? 'error' : 
                     severity === ErrorSeverity.HIGH ? 'error' : 
                     severity === ErrorSeverity.MEDIUM ? 'warn' : 'warn';

    console[logLevel](`[${category}:${severity}] ${operation} - ${error.message}`, {
      errorId,
      context,
      deviceId,
      metadata
    });

    return errorId;
  }

  getErrorStats(): ErrorStats {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const byCategory = Object.values(ErrorCategory).reduce((acc, category) => {
      acc[category] = this.errors.filter(e => e.category === category).length;
      return acc;
    }, {} as Record<ErrorCategory, number>);

    const bySeverity = Object.values(ErrorSeverity).reduce((acc, severity) => {
      acc[severity] = this.errors.filter(e => e.severity === severity).length;
      return acc;
    }, {} as Record<ErrorSeverity, number>);

    return {
      total: this.errors.length,
      byCategory,
      bySeverity,
      recent: this.errors.slice(-10), // Last 10 errors
      trends: {
        lastHour: this.errors.filter(e => e.timestamp >= oneHourAgo).length,
        lastDay: this.errors.filter(e => e.timestamp >= oneDayAgo).length,
        lastWeek: this.errors.filter(e => e.timestamp >= oneWeekAgo).length
      }
    };
  }

  getErrorsByCategory(category: ErrorCategory, limit = 10): CategorizedError[] {
    return this.errors
      .filter(e => e.category === category)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  getErrorsBySeverity(severity: ErrorSeverity, limit = 10): CategorizedError[] {
    return this.errors
      .filter(e => e.severity === severity)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  getCriticalErrors(limit = 5): CategorizedError[] {
    return this.getErrorsBySeverity(ErrorSeverity.CRITICAL, limit);
  }

  getFrequentErrors(limit = 5): Array<{ message: string; count: number; category: ErrorCategory }> {
    const errorCounts = new Map<string, { count: number; category: ErrorCategory }>();
    
    this.errors.forEach(error => {
      const key = `${error.category}:${error.message}`;
      if (errorCounts.has(key)) {
        errorCounts.get(key)!.count++;
      } else {
        errorCounts.set(key, { count: 1, category: error.category });
      }
    });

    return Array.from(errorCounts.entries())
      .map(([message, data]) => ({ 
        message: message.split(':')[1], 
        count: data.count, 
        category: data.category 
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  clearErrors(): void {
    this.errors = [];
  }

  private generateErrorId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private cleanupOldErrors(): void {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const initialCount = this.errors.length;
    
    this.errors = this.errors.filter(error => error.timestamp >= sevenDaysAgo);
    
    const removedCount = initialCount - this.errors.length;
    if (removedCount > 0) {
      console.log(`🧹 Cleaned up ${removedCount} old error records`);
    }
  }

  // Get error summary for logging/reporting
  getErrorSummary(): string {
    const stats = this.getErrorStats();
    const criticalCount = stats.bySeverity[ErrorSeverity.CRITICAL];
    const highCount = stats.bySeverity[ErrorSeverity.HIGH];
    
    return `Errors: ${stats.total} total, ${stats.trends.lastHour} in last hour, ` +
           `${criticalCount} critical, ${highCount} high severity`;
  }

  // Check if error rates are concerning
  isErrorRateConcerning(): boolean {
    const stats = this.getErrorStats();
    const criticalErrors = stats.bySeverity[ErrorSeverity.CRITICAL];
    const hourlyErrors = stats.trends.lastHour;
    
    return criticalErrors > 0 || hourlyErrors > 10; // More than 10 errors per hour
  }
}

// Create global instance
export const errorTracker = new ErrorTracker();

// Utility function for easier error tracking
export function trackError(
  error: any,
  context: string,
  operation: string,
  deviceId?: string,
  metadata?: any
): string {
  return errorTracker.trackError(error, context, operation, deviceId, metadata);
}

// Utility function for error logging with automatic categorization
export function logCategorizedError(
  message: string,
  error: any,
  context: string,
  operation: string,
  deviceId?: string
): string {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  return trackError(errorObj, context, operation, deviceId, { originalMessage: message });
}

export { ErrorTracker };
