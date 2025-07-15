import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { 
  ChargeRequest, 
  Transaction, 
  Provider, 
  TransactionStatus,
  ChargeResponse,
  HealthCheckResponse,
  ServiceStats,
  TransactionMetadata
} from '../models/types';
import { safeValidateChargeRequest } from '../utils/validation';
import { 
  handleValidationError, 
  handleNotFoundError, 
  handleServerError,
  createErrorResponse
} from '../utils/errorHandler';
import { fraudService } from '../services/fraud.service';
import { geminiService } from '../services/gemini.service';
import { storageService } from '../services/storage.service';
import logger from '../utils/logger';

/**
 * Payment controller handling all charge-related endpoints
 * Provides REST API endpoints for payment processing, transaction retrieval, and system monitoring
 */
export class PaymentController {
  /**
   * Process a charge request through the payment gateway proxy
   * 
   * Validates input, calculates fraud risk, determines appropriate payment provider,
   * enhances risk explanation with AI, and stores transaction for audit trail
   * 
   * @param req Express request object containing charge details (amount, currency, source, email)
   * @param res Express response object for sending results
   * @returns Promise<void> - Sends JSON response with transaction details and provider routing
   * 
   * @example
   * POST /charge
   * {
   *   "amount": 1000,
   *   "currency": "USD", 
   *   "source": "tok_visa",
   *   "email": "user@example.com"
   * }
   * 
   * Response:
   * {
   *   "transactionId": "uuid",
   *   "provider": "stripe|paypal|blocked",
   *   "status": "success|blocked",
   *   "riskScore": 0.3,
   *   "explanation": "AI-generated risk explanation"
   * }
   */
  async processPayment(req: Request, res: Response): Promise<void> {
    const requestId = (req as any).requestId || uuidv4();
    const startTime = Date.now();

    logger.info('Charge request received', { 
      requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    try {
      // Validate input
      const validationResult = safeValidateChargeRequest(req.body);
      
      if (!validationResult.success) {
        handleValidationError(validationResult.errors, req, res);
        return;
      }

      const chargeRequest: ChargeRequest = validationResult.data;

      // Calculate fraud risk score (now returns just a number)
      const riskScore = await fraudService.calculateRiskScore(chargeRequest);
      
      // Get full risk assessment for detailed logging
      const fullRiskAssessment = await fraudService.getFullRiskAssessment(chargeRequest);
      
      // Determine provider using service logic
      const provider = fraudService.determineProvider(riskScore);
      const status = provider === 'blocked' ? 'blocked' : 'success';

      // Log detailed fraud decision reasoning
      logger.info('Fraud assessment completed', {
        requestId,
        riskScore,
        provider,
        status,
        riskFactors: fullRiskAssessment.factors,
        riskReasons: fullRiskAssessment.factors.map(factor => {
          if (factor.type === 'amount') {
            return `Large amount: $${chargeRequest.amount}`;
          } else if (factor.type === 'email_domain') {
            return `Suspicious email domain: ${chargeRequest.email.split('@')[1]}`;
          }
          return factor.description;
        }),
        decision: {
          reasoning: `Risk score ${riskScore} → ${provider} (${status})`,
          threshold: provider === 'stripe' ? '<0.25' : provider === 'paypal' ? '0.25-0.5' : '≥0.5'
        }
      });

      // Enhance risk explanation with AI (with fallback)
      const enhancedExplanation = await geminiService.enhanceRiskExplanation(
        fullRiskAssessment,
        chargeRequest.amount,
        chargeRequest.email,
        chargeRequest.source
      );

      // Create transaction metadata
      const metadata: TransactionMetadata = {
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip,
        riskFactors: fullRiskAssessment.factors,
        processingTimeMs: Date.now() - startTime
      };

      // Create transaction record
      const transaction: Transaction = {
        id: requestId,
        amount: chargeRequest.amount,
        currency: chargeRequest.currency,
        source: chargeRequest.source,
        email: chargeRequest.email,
        riskScore,
        explanation: enhancedExplanation,
        provider,
        status,
        timestamp: new Date(),
        metadata
      };

      // Save transaction
      await storageService.saveTransaction(transaction);

      // Simulate payment processing for non-blocked transactions
      if (status !== 'blocked') {
        this.simulatePaymentProcessing(transaction.id, provider);
      }

      const processingTime = Date.now() - startTime;

      // Prepare response
      const response: ChargeResponse = {
        transactionId: transaction.id,
        provider,
        status,
        riskScore,
        explanation: enhancedExplanation
      };

      logger.info('Charge processed successfully', {
        requestId,
        transactionId: transaction.id,
        riskScore,
        provider,
        status,
        processingTime
      });

      res.status(200).json(response);

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      logger.error('Charge processing failed', {
        requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
        processingTime
      });

      handleServerError(
        error instanceof Error ? error : new Error('Unknown error'),
        req,
        res,
        'Failed to process charge request'
      );
    }
  }

  /**
   * Retrieve a specific transaction by its unique identifier
   * 
   * @param req Express request object with transactionId parameter
   * @param res Express response object for sending transaction data
   * @returns Promise<void> - Sends JSON response with full transaction details
   * 
   * @example
   * GET /transaction/uuid-here
   * 
   * Response:
   * {
   *   "id": "uuid",
   *   "amount": 1000,
   *   "currency": "USD",
   *   "provider": "stripe",
   *   "status": "success",
   *   "riskScore": 0.2,
   *   "timestamp": "2024-01-01T00:00:00.000Z",
   *   "metadata": { ... }
   * }
   */
  async getTransaction(req: Request, res: Response): Promise<void> {
    try {
      const { transactionId } = req.params;

      if (!transactionId) {
        const errorResponse = createErrorResponse(
          'Missing Parameter',
          'Transaction ID is required',
          400,
          req
        );
        res.status(400).json(errorResponse);
        return;
      }

      const transaction = await storageService.getTransaction(transactionId);

      if (!transaction) {
        handleNotFoundError('Transaction', transactionId, req, res);
        return;
      }

      logger.info('Transaction retrieved', { transactionId });
      res.status(200).json(transaction);

    } catch (error) {
      logger.error('Failed to retrieve transaction', {
        transactionId: req.params.transactionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      handleServerError(
        error instanceof Error ? error : new Error('Unknown error'),
        req,
        res,
        'Failed to retrieve transaction'
      );
    }
  }

  /**
   * Retrieve all transactions stored in the system
   * 
   * Returns complete transaction history with count and metadata.
   * Useful for auditing and administrative purposes.
   * 
   * @param req Express request object
   * @param res Express response object for sending transaction array
   * @returns Promise<void> - Sends JSON response with all transactions and count
   * 
   * @example
   * GET /transactions
   * 
   * Response:
   * {
   *   "transactions": [...],
   *   "count": 42,
   *   "timestamp": "2024-01-01T00:00:00.000Z"
   * }
   */
  async getAllTransactions(req: Request, res: Response): Promise<void> {
    try {
      const transactions = await storageService.getAllTransactions();

      logger.info('All transactions retrieved successfully', { 
        count: transactions.length,
        requestIp: req.ip 
      });

      res.status(200).json({
        transactions,
        count: transactions.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error retrieving all transactions', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        requestIp: req.ip
      });

      handleServerError(
        error instanceof Error ? error : new Error('Unknown error'),
        req,
        res,
        'Failed to retrieve transactions'
      );
    }
  }

  /**
   * System health check endpoint
   * 
   * Verifies the operational status of all system components including
   * storage service and external AI service (Gemini). Returns overall
   * health status and individual service states.
   * 
   * @param req Express request object
   * @param res Express response object for sending health status
   * @returns Promise<void> - Sends JSON response with system health information
   * 
   * @example
   * GET /health
   * 
   * Response:
   * {
   *   "status": "healthy|unhealthy",
   *   "timestamp": "2024-01-01T00:00:00.000Z",
   *   "version": "1.0.0",
   *   "services": {
   *     "gemini": true,
   *     "storage": true
   *   }
   * }
   */
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const [geminiHealth, storageHealth] = await Promise.all([
        geminiService.healthCheck(),
        storageService.healthCheck()
      ]);

      const isHealthy = storageHealth; // Gemini is optional
      const response: HealthCheckResponse = {
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: {
          gemini: geminiHealth,
          storage: storageHealth
        }
      };

      const statusCode = isHealthy ? 200 : 503;
      res.status(statusCode).json(response);

      logger.info('Health check completed', { 
        status: response.status,
        services: response.services 
      });

    } catch (error) {
      logger.error('Health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      handleServerError(
        error instanceof Error ? error : new Error('Unknown error'),
        req,
        res,
        'Health check failed'
      );
    }
  }

  /**
   * Retrieve comprehensive system statistics and performance metrics
   * 
   * Provides detailed information about storage usage, service availability,
   * performance metrics including memory usage, rate limiting stats,
   * and system environment details. Useful for monitoring and debugging.
   * 
   * @param req Express request object (may contain performance stats from middleware)
   * @param res Express response object for sending statistics
   * @returns Promise<void> - Sends JSON response with comprehensive system statistics
   * 
   * @example
   * GET /stats
   * 
   * Response:
   * {
   *   "storage": { "totalTransactions": 42, "memoryUsage": "1.2MB" },
   *   "services": { "geminiAvailable": true, "fraudService": true },
   *   "uptime": 3600,
   *   "performance": {
   *     "rateLimiter": { "totalKeys": 5, "config": {...} },
   *     "memory": { "heapUsed": 45.2, "memoryUsagePercent": 8 },
   *     "environment": { "nodeVersion": "v18.0.0", "platform": "darwin" }
   *   },
   *   "timestamp": "2024-01-01T00:00:00.000Z"
   * }
   */
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const storageStats = storageService.getStats();
      const geminiAvailable = geminiService.isServiceAvailable();
      const performanceStats = (req as any).performanceStats || {};

      const stats: ServiceStats & { performance?: any } = {
        storage: storageStats,
        services: {
          geminiAvailable,
          fraudService: fraudService.healthCheck()
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        ...(performanceStats && {
          performance: {
            rateLimiter: performanceStats.rateLimiter,
            memory: performanceStats.memory,
            environment: {
              nodeVersion: process.version,
              platform: process.platform,
              architecture: process.arch
            }
          }
        })
      };

      res.status(200).json(stats);
      logger.info('Statistics retrieved', {
        requestId: (req as any).requestId,
        hasPerformanceStats: !!performanceStats.rateLimiter
      });

    } catch (error) {
      logger.error('Failed to retrieve statistics', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      handleServerError(
        error instanceof Error ? error : new Error('Unknown error'),
        req,
        res,
        'Failed to retrieve statistics'
      );
    }
  }

  /**
   * Simulate payment processing (async)
   */
  private simulatePaymentProcessing(transactionId: string, provider: Provider): void {
    // Simulate processing delay
    setTimeout(async () => {
      try {
        const success = Math.random() > 0.1; // 90% success rate
        const newStatus: TransactionStatus = success ? 'success' : 'error';
        
        await storageService.updateTransactionStatus(
          transactionId, 
          newStatus, 
          new Date()
        );

        logger.info('Payment processing completed', {
          transactionId,
          provider,
          status: newStatus
        });

      } catch (error) {
        logger.error('Payment processing simulation failed', {
          transactionId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }, 2000 + Math.random() * 3000); // 2-5 second delay
  }
}

// Export singleton instance
export const paymentController = new PaymentController(); 