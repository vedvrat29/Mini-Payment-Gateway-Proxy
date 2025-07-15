import { Request, Response, NextFunction } from 'express';
import { handleTimeoutError } from './errorHandler';
import logger from './logger';

/**
 * Request timeout middleware
 */
export function createTimeoutMiddleware(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req as any).requestId;
    
    // Set a timeout for the request
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        logger.error('Request timeout exceeded', {
          requestId,
          timeoutMs,
          path: req.path,
          method: req.method
        });
        
        handleTimeoutError(`Request processing (${timeoutMs}ms)`, req, res);
      }
    }, timeoutMs);

    // Clear timeout when response is sent
    const originalSend = res.send;
    res.send = function(body) {
      clearTimeout(timeout);
      return originalSend.call(this, body);
    };

    // Clear timeout when response ends
    res.on('finish', () => {
      clearTimeout(timeout);
    });

    next();
  };
}

/**
 * Memory monitoring utilities
 */
export class MemoryMonitor {
  private readonly maxMemoryMB: number;
  private readonly checkIntervalMs: number;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private alerts: { timestamp: Date; memoryMB: number }[] = [];

  constructor(maxMemoryMB: number = 512, checkIntervalMs: number = 30000) {
    this.maxMemoryMB = maxMemoryMB;
    this.checkIntervalMs = checkIntervalMs;
  }

  /**
   * Start memory monitoring
   */
  start(): void {
    this.monitoringInterval = setInterval(() => {
      this.checkMemoryUsage();
    }, this.checkIntervalMs);

    logger.info('Memory monitoring started', {
      maxMemoryMB: this.maxMemoryMB,
      checkIntervalMs: this.checkIntervalMs
    });
  }

  /**
   * Stop memory monitoring
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    logger.info('Memory monitoring stopped');
  }

  /**
   * Get current memory usage statistics
   */
  getMemoryStats() {
    const memUsage = process.memoryUsage();
    const memoryMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
      external: Math.round(memUsage.external / 1024 / 1024 * 100) / 100
    };

    return {
      memory: memoryMB,
      maxMemoryMB: this.maxMemoryMB,
      memoryUsagePercent: Math.round((memoryMB.heapUsed / this.maxMemoryMB) * 100),
      recentAlerts: this.alerts.slice(-5) // Last 5 alerts
    };
  }

  /**
   * Check current memory usage and log warnings
   */
  private checkMemoryUsage(): void {
    const stats = this.getMemoryStats();
    const currentMemoryMB = stats.memory.heapUsed;
    const usagePercent = stats.memoryUsagePercent;

    // Log memory stats periodically
    logger.debug('Memory usage check', {
      memoryMB: stats.memory,
      usagePercent,
      maxMemoryMB: this.maxMemoryMB
    });

    // Warn if memory usage is high
    if (usagePercent > 80) {
      const alert = {
        timestamp: new Date(),
        memoryMB: currentMemoryMB
      };
      
      this.alerts.push(alert);
      
      // Keep only last 10 alerts
      if (this.alerts.length > 10) {
        this.alerts.shift();
      }

      logger.warn('High memory usage detected', {
        currentMemoryMB,
        maxMemoryMB: this.maxMemoryMB,
        usagePercent,
        alertCount: this.alerts.length
      });

      // Force garbage collection if available (only in development)
      if (global.gc && process.env.NODE_ENV === 'development') {
        logger.info('Forcing garbage collection due to high memory usage');
        global.gc();
      }
    }

    // Critical memory usage
    if (usagePercent > 95) {
      logger.error('Critical memory usage detected', {
        currentMemoryMB,
        maxMemoryMB: this.maxMemoryMB,
        usagePercent,
        message: 'Consider restarting the application'
      });
    }
  }

  /**
   * Force a memory check (useful for manual monitoring)
   */
  checkNow(): ReturnType<MemoryMonitor['getMemoryStats']> {
    this.checkMemoryUsage();
    return this.getMemoryStats();
  }
}

/**
 * Transaction storage monitoring
 */
export class StorageMonitor {
  private readonly maxTransactions: number;
  private readonly cleanupThreshold: number;

  constructor(maxTransactions: number = 10000, cleanupThreshold: number = 0.8) {
    this.maxTransactions = maxTransactions;
    this.cleanupThreshold = cleanupThreshold;
  }

  /**
   * Check if storage cleanup is needed
   */
  shouldCleanup(currentCount: number): boolean {
    const threshold = this.maxTransactions * this.cleanupThreshold;
    return currentCount >= threshold;
  }

  /**
   * Get storage statistics
   */
  getStorageStats(currentCount: number) {
    const usagePercent = Math.round((currentCount / this.maxTransactions) * 100);
    const shouldCleanup = this.shouldCleanup(currentCount);

    return {
      currentTransactions: currentCount,
      maxTransactions: this.maxTransactions,
      usagePercent,
      shouldCleanup,
      cleanupThreshold: Math.round(this.maxTransactions * this.cleanupThreshold)
    };
  }

  /**
   * Log storage statistics
   */
  logStorageStats(currentCount: number): void {
    const stats = this.getStorageStats(currentCount);
    
    if (stats.shouldCleanup) {
      logger.warn('Storage cleanup recommended', stats);
    } else {
      logger.debug('Storage usage check', stats);
    }
  }
}

// Global instances
export const memoryMonitor = new MemoryMonitor(
  parseInt(process.env.MAX_MEMORY_MB || '512'),
  parseInt(process.env.MEMORY_CHECK_INTERVAL_MS || '30000')
);

export const storageMonitor = new StorageMonitor(
  parseInt(process.env.MAX_TRANSACTIONS || '10000'),
  parseFloat(process.env.STORAGE_CLEANUP_THRESHOLD || '0.8')
);

/**
 * Performance monitoring middleware that adds performance headers
 */
export function performanceMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = process.hrtime.bigint();
    
    // Add performance monitoring
    const originalSend = res.send;
    res.send = function(body) {
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000; // Convert to milliseconds
      
      // Add performance headers
      res.set({
        'X-Response-Time': `${durationMs.toFixed(2)}ms`,
        'X-Memory-Usage': `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
      });

      // Log slow requests
      if (durationMs > 1000) {
        logger.warn('Slow request detected', {
          requestId: (req as any).requestId,
          path: req.path,
          method: req.method,
          durationMs: durationMs.toFixed(2),
          statusCode: res.statusCode
        });
      }

      return originalSend.call(this, body);
    };

    next();
  };
} 