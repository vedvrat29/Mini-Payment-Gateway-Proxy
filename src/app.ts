import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { paymentController } from './controllers/payment.controller';
import { validateEnvironment } from './utils/validation';
import { errorHandlingMiddleware, createErrorResponse } from './utils/errorHandler';
import { createAPIRateLimiter } from './utils/rateLimiter';
import { createTimeoutMiddleware, performanceMiddleware, memoryMonitor } from './utils/performance';
import logger from './utils/logger';

// Load environment variables with explicit path
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Validate environment variables
try {
  validateEnvironment();
  logger.info('Environment validation passed');
} catch (error) {
  logger.error('Environment validation failed', { 
    error: error instanceof Error ? error.message : 'Unknown error' 
  });
  // Don't exit in test environment to allow tests to run
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize performance monitoring
memoryMonitor.start();

// Graceful shutdown handler for memory monitor
process.on('SIGTERM', () => {
  memoryMonitor.stop();
});

process.on('SIGINT', () => {
  memoryMonitor.stop();
});

// Basic middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Performance and security middleware
const rateLimiter = createAPIRateLimiter();
app.use(rateLimiter.middleware());
app.use(createTimeoutMiddleware(30000)); // 30 second timeout
app.use(performanceMiddleware());

// Request logging middleware with comprehensive tracking
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] as string || uuidv4();
  
  // Add request ID to request object for use in controllers
  (req as any).requestId = requestId;
  
  // Sanitize request body (remove sensitive data)
  const sanitizedBody = req.body ? { ...req.body } : {};
  if (sanitizedBody.source) {
    sanitizedBody.source = sanitizedBody.source.substring(0, 8) + '***'; // Mask payment source
  }
  if (sanitizedBody.email) {
    const [localPart, domain] = sanitizedBody.email.split('@');
    sanitizedBody.email = localPart.substring(0, 2) + '***@' + domain; // Mask email
  }

  logger.info('Request received', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    contentLength: req.get('Content-Length'),
    body: Object.keys(sanitizedBody).length > 0 ? sanitizedBody : undefined
  });

  // Track response time
  const originalSend = res.send;
  res.send = function(body) {
    const responseTime = Date.now() - startTime;
    
    logger.info('Request completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      contentLength: body ? body.length : 0
    });
    
    return originalSend.call(this, body);
  };

  next();
});

// Health check endpoint
app.get('/health', paymentController.healthCheck.bind(paymentController));

// Statistics endpoint with enhanced performance metrics
app.get('/stats', (req, res) => {
  // Add performance stats to request for controller access
  (req as any).performanceStats = {
    rateLimiter: rateLimiter.getStats(),
    memory: memoryMonitor.getMemoryStats()
  };
  paymentController.getStats(req, res);
});

// Charge processing routes
app.post('/charge', paymentController.processPayment.bind(paymentController));
app.get('/transaction/:transactionId', paymentController.getTransaction.bind(paymentController));
app.get('/transactions', paymentController.getAllTransactions.bind(paymentController));

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'Payment Gateway Proxy',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      stats: '/stats',
      processCharge: 'POST /charge',
      getTransaction: 'GET /transaction/:transactionId',
      getAllTransactions: 'GET /transactions'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  const errorResponse = createErrorResponse(
    'Route Not Found',
    `Route ${req.method} ${req.originalUrl} not found. Please check the API documentation for available endpoints.`,
    404,
    req,
    { 
      availableEndpoints: [
        'GET /health',
        'GET /stats', 
        'POST /charge',
        'GET /transaction/:id',
        'GET /transactions'
      ]
    }
  );

  logger.warn('Route not found', {
    requestId: (req as any).requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip
  });

  res.status(404).json(errorResponse);
});

// Global error handler
app.use(errorHandlingMiddleware);

// Start server
const server = app.listen(PORT, () => {
  logger.info(`server started at http://localhost:${PORT}/health`);
  logger.info(`server started at http://localhost:${PORT}/stats`);
  // logger.info(`server started at http://localhost:${PORT}/transaction/:transactionId`);
});

// Graceful shutdown
const gracefulShutdown = () => {
  logger.info('Shutdown signal received, shutting down gracefully');
  
  // Stop monitoring
  memoryMonitor.stop();
  rateLimiter.destroy();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default app; 