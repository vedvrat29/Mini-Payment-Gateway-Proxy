import { Request, Response, NextFunction } from 'express';
import { handleRateLimitError } from './errorHandler';
import logger from './logger';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  windowMs: number;    // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyGenerator?: (req: Request) => string; // Custom key generator
  skipSuccessfulRequests?: boolean; // Don't count successful requests
  skipFailedRequests?: boolean;     // Don't count failed requests
}

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly store = new Map<string, RateLimitEntry>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.config = {
      keyGenerator: (req) => req.ip || 'unknown',
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      ...config
    };

    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  /**
   * Create Express middleware for rate limiting
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const config = this.config; // Capture config for use in nested function
      const key = config.keyGenerator!(req);
      const now = Date.now();
      
      // Get or create entry
      let entry = this.store.get(key);
      if (!entry || now >= entry.resetTime) {
        entry = {
          count: 0,
          resetTime: now + config.windowMs
        };
        this.store.set(key, entry);
      }

      // Check if limit exceeded
      if (entry.count >= config.maxRequests) {
        const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
        
        logger.warn('Rate limit exceeded', {
          key,
          count: entry.count,
          limit: config.maxRequests,
          retryAfter,
          requestId: (req as any).requestId
        });

        handleRateLimitError(req, res, retryAfter);
        return;
      }

      // Increment counter
      entry.count++;

      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': config.maxRequests.toString(),
        'X-RateLimit-Remaining': (config.maxRequests - entry.count).toString(),
        'X-RateLimit-Reset': new Date(entry.resetTime).toISOString()
      });

      // Track response to optionally skip counting
      const originalSend = res.send;
      res.send = function(body) {
        const statusCode = res.statusCode;
        
        // Adjust count based on configuration
        if (
          (statusCode >= 200 && statusCode < 400 && config.skipSuccessfulRequests) ||
          (statusCode >= 400 && config.skipFailedRequests)
        ) {
          entry!.count--;
        }

        return originalSend.call(this, body);
      };

      next();
    };
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.resetTime) {
        this.store.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug('Rate limiter cleanup completed', {
        cleanedEntries: cleanedCount,
        remainingEntries: this.store.size
      });
    }
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      totalKeys: this.store.size,
      config: {
        windowMs: this.config.windowMs,
        maxRequests: this.config.maxRequests
      }
    };
  }

  /**
   * Reset all counters (useful for testing)
   */
  reset(): void {
    this.store.clear();
    logger.info('Rate limiter reset');
  }

  /**
   * Cleanup and stop background tasks
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
    logger.info('Rate limiter destroyed');
  }
}

// Pre-configured rate limiters for different use cases
export const createBasicRateLimiter = (maxRequests: number = 100, windowMs: number = 60000) => 
  new RateLimiter({ maxRequests, windowMs });

export const createStrictRateLimiter = (maxRequests: number = 10, windowMs: number = 60000) => 
  new RateLimiter({ maxRequests, windowMs });

export const createAPIRateLimiter = () => 
  new RateLimiter({ 
    maxRequests: 100, 
    windowMs: 60000,
    skipSuccessfulRequests: false 
  }); 