import { z } from 'zod';

/**
 * Validation schemas for payment gateway proxy
 */

// Charge request validation schema
export const chargeRequestSchema = z.object({
  amount: z
    .number()
    .positive('Amount must be a positive number')
    .max(100000, 'Amount cannot exceed $100,000')
    .refine((val) => Number.isFinite(val), 'Amount must be a valid number')
    .refine((val) => {
      const decimalPart = val.toString().split('.')[1];
      return val % 0.01 === 0 || !decimalPart || decimalPart.length <= 2;
    }, 'Amount cannot have more than 2 decimal places'),
  
  currency: z
    .string()
    .length(3, 'Currency must be a 3-letter ISO code')
    .regex(/^[A-Z]{3}$/, 'Currency must be uppercase letters only')
    .refine((val) => ['USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(val), 
            'Supported currencies: USD, EUR, GBP, CAD, AUD'),
  
  source: z
    .string()
    .min(1, 'Payment source is required')
    .max(100, 'Payment source identifier too long'),
  
  email: z
    .string()
    .email('Invalid email format')
    .max(254, 'Email address too long')
    .toLowerCase()
});

// Environment variables validation
export const envSchema = z.object({
  PORT: z.string().default('3000').transform(Number),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GEMINI_API_KEY: z.string().min(1, 'Gemini API key is required'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
  FRAUD_THRESHOLD: z.string().default('0.5').transform(Number),
  MAX_SAFE_AMOUNT: z.string().default('500').transform(Number),
  RATE_LIMIT: z.string().default('100').transform(Number)
});

/**
 * Validates charge request data
 */
export function validateChargeRequest(data: unknown) {
  return chargeRequestSchema.parse(data);
}

/**
 * Validates environment variables
 */
export function validateEnvironment() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
      throw new Error(`Environment validation failed:\n${missingVars.join('\n')}`);
    }
    throw error;
  }
}

/**
 * Safe validation that returns result with success flag
 */
export function safeValidateChargeRequest(data: unknown) {
  const result = chargeRequestSchema.safeParse(data);
  
  if (!result.success) {
    return {
      success: false as const,
      errors: result.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code
      }))
    };
  }
  
  return {
    success: true as const,
    data: result.data
  };
} 