import { Request, Response } from 'express';
import logger from './logger';

export interface StandardErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
  path: string;
  requestId?: string;
  details?: any;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: any;

  constructor(message: string, statusCode: number, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.details = details;
    
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  error: string,
  message: string,
  statusCode: number,
  req: Request,
  details?: any
): StandardErrorResponse {
  return {
    error,
    message,
    statusCode,
    timestamp: new Date().toISOString(),
    path: req.path,
    requestId: (req as any).requestId,
    ...(details && { details })
  };
}

/**
 * Handle validation errors with helpful messages
 */
export function handleValidationError(
  validationErrors: any[],
  req: Request,
  res: Response
): void {
  const formattedErrors = validationErrors.map(err => ({
    field: err.path?.join('.') || 'unknown',
    message: err.message,
    received: err.received,
    expected: err.expected
  }));

  const errorResponse = createErrorResponse(
    'Validation Error',
    'Invalid request data. Please check the required fields and formats.',
    400,
    req,
    { validationErrors: formattedErrors }
  );

  logger.warn('Validation error occurred', {
    requestId: (req as any).requestId,
    path: req.path,
    method: req.method,
    errors: formattedErrors
  });

  res.status(400).json(errorResponse);
}

/**
 * Handle not found errors
 */
export function handleNotFoundError(
  resourceType: string,
  resourceId: string,
  req: Request,
  res: Response
): void {
  const errorResponse = createErrorResponse(
    'Resource Not Found',
    `${resourceType} with ID '${resourceId}' was not found.`,
    404,
    req,
    { resourceType, resourceId }
  );

  logger.warn('Resource not found', {
    requestId: (req as any).requestId,
    resourceType,
    resourceId,
    path: req.path
  });

  res.status(404).json(errorResponse);
}

/**
 * Handle external service errors
 */
export function handleExternalServiceError(
  serviceName: string,
  error: Error,
  req: Request,
  res: Response
): void {
  const errorResponse = createErrorResponse(
    'External Service Error',
    `${serviceName} service is currently unavailable. Please try again later.`,
    503,
    req,
    { serviceName, reason: 'Service unavailable' }
  );

  logger.error('External service error', {
    requestId: (req as any).requestId,
    serviceName,
    error: error.message,
    stack: error.stack,
    path: req.path
  });

  res.status(503).json(errorResponse);
}

/**
 * Handle rate limiting errors
 */
export function handleRateLimitError(
  req: Request,
  res: Response,
  retryAfter?: number
): void {
  const errorResponse = createErrorResponse(
    'Rate Limit Exceeded',
    'Too many requests. Please try again later.',
    429,
    req,
    { retryAfter: retryAfter || 60 }
  );

  if (retryAfter) {
    res.set('Retry-After', retryAfter.toString());
  }

  logger.warn('Rate limit exceeded', {
    requestId: (req as any).requestId,
    ip: req.ip,
    path: req.path,
    retryAfter
  });

  res.status(429).json(errorResponse);
}

/**
 * Handle timeout errors
 */
export function handleTimeoutError(
  operation: string,
  req: Request,
  res: Response
): void {
  const errorResponse = createErrorResponse(
    'Request Timeout',
    `${operation} operation timed out. Please try again.`,
    408,
    req,
    { operation, timeout: true }
  );

  logger.error('Request timeout', {
    requestId: (req as any).requestId,
    operation,
    path: req.path,
    method: req.method
  });

  res.status(408).json(errorResponse);
}

/**
 * Handle general server errors
 */
export function handleServerError(
  error: Error,
  req: Request,
  res: Response,
  customMessage?: string
): void {
  const errorResponse = createErrorResponse(
    'Internal Server Error',
    customMessage || 'An unexpected error occurred. Please try again later.',
    500,
    req
  );

  logger.error('Server error', {
    requestId: (req as any).requestId,
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  res.status(500).json(errorResponse);
}

/**
 * Express error handling middleware
 */
export function errorHandlingMiddleware(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: Function
): void {
  if (err instanceof AppError) {
    const errorResponse = createErrorResponse(
      err.name,
      err.message,
      err.statusCode,
      req,
      err.details
    );

    logger.error('Application error', {
      requestId: (req as any).requestId,
      error: err.message,
      statusCode: err.statusCode,
      details: err.details,
      path: req.path
    });

    res.status(err.statusCode).json(errorResponse);
  } else {
    handleServerError(err, req, res);
  }
} 