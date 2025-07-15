/**
 * Core types and interfaces for the payment gateway proxy
 * Business-focused interfaces that represent clear domain concepts
 */

/**
 * Charge request from client
 */
export interface ChargeRequest {
  amount: number;
  currency: string;
  source: string; // Payment source identifier (card token, payment method, etc.)
  email: string;
}

/**
 * Charge response to client
 */
export interface ChargeResponse {
  transactionId: string;
  provider: Provider;
  status: TransactionStatus;
  riskScore: number;
  explanation: string;
}

/**
 * Transaction record for storage with metadata
 */
export interface Transaction {
  id: string;
  amount: number;
  currency: string;
  source: string;
  email: string;
  riskScore: number;
  explanation: string;
  provider: Provider;
  status: TransactionStatus;
  timestamp: Date;
  processedAt?: Date | undefined;
  metadata: TransactionMetadata;
}

/**
 * Additional transaction metadata for auditing and analysis
 */
export interface TransactionMetadata {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  riskFactors: RiskFactor[];
  processingTimeMs?: number | undefined;
}

/**
 * Risk factor identified during fraud assessment
 */
export interface RiskFactor {
  type: 'amount' | 'email_domain';
  value: string | number;
  impact: 'low' | 'medium' | 'high';
  description: string;
}

/**
 * Fraud risk assessment result
 */
export interface FraudRiskAssessment {
  score: number; // 0-1 scale
  explanation: string;
  factors: RiskFactor[];
}

/**
 * Payment provider options
 */
export type Provider = "stripe" | "paypal" | "blocked";

/**
 * Transaction status types
 */
export type TransactionStatus = "success" | "blocked" | "error";

/**
 * API error response structure
 */
export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
  path?: string | undefined;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  version: string;
  services: {
    gemini: boolean;
    storage: boolean;
  };
}

/**
 * Service statistics response
 */
export interface ServiceStats {
  storage: {
    totalTransactions: number;
    memoryUsage: string;
  };
  services: {
    geminiAvailable: boolean;
    fraudService: boolean;
  };
  uptime: number;
  timestamp: string;
} 