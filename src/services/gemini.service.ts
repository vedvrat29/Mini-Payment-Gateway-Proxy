import { GoogleGenerativeAI } from '@google/generative-ai';
import { FraudRiskAssessment } from '../models/types';
import logger from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

// Cache for storing AI responses
interface CacheEntry {
  response: string;
  timestamp: number;
}

/**
 * Google Gemini AI service for enhanced risk explanations
 */
export class GeminiService {
  private genAI: GoogleGenerativeAI | null;
  private model: any;
  private isAvailable: boolean;
  private promptCache: Map<string, CacheEntry>;
  private readonly cacheExpiryMs = 60 * 60 * 1000; // 1 hour (3600000ms)
  private readonly modelOptions = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  private currentModel: string | null = null;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    this.promptCache = new Map();
    this.genAI = null;
    this.isAvailable = false;
    
    if (!apiKey) {
      logger.warn('Gemini API key not provided, AI explanations will not be available', {
        service: 'payment-gateway-proxy'
      });
      return;
    }

    this.initializeWithModelDiscovery(apiKey);
  }

  /**
   * Initialize Gemini service with model discovery
   */
  private async initializeWithModelDiscovery(apiKey: string): Promise<void> {
    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      
      // Try to find an available model
      const workingModel = await this.findAvailableModel();
      
      if (workingModel) {
        this.model = this.genAI.getGenerativeModel({ model: workingModel });
        this.currentModel = workingModel;
        this.isAvailable = true;
        logger.info('Gemini AI service initialized successfully', { 
          model: workingModel 
        });
      } else {
        throw new Error('No available Gemini models found');
      }
    } catch (error) {
      logger.error('Failed to initialize Gemini AI service', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      this.genAI = null;
      this.isAvailable = false;
    }
  }

  /**
   * Find the first available model from the options
   */
  private async findAvailableModel(): Promise<string | null> {
    for (const modelName of this.modelOptions) {
      try {
        logger.debug('Testing model availability', { model: modelName });
        
        const testModel = this.genAI!.getGenerativeModel({ model: modelName });
        
        // Test the model with a simple prompt
        const result = await Promise.race([
          testModel.generateContent('Test'),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Model test timeout')), 3000)
          )
        ]);

        if (result) {
          logger.info('Found working Gemini model', { model: modelName });
          return modelName;
        }
      } catch (error) {
        logger.debug('Model not available', { 
          model: modelName,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        continue;
      }
    }

    logger.warn('No working Gemini models found from options', { 
      attempted: this.modelOptions 
    });
    return null;
  }

  /**
   * Enhance risk explanation using Gemini AI with caching
   */
  async enhanceRiskExplanation(
    riskAssessment: FraudRiskAssessment,
    chargeAmount: number,
    userEmail: string,
    paymentSource: string
  ): Promise<string> {
    // Return fallback explanation if AI is not available
    if (!this.isAvailable || !this.genAI || !this.model) {
      logger.debug('Gemini AI not available, using fallback explanation');
      return this.generateFallbackExplanation(riskAssessment);
    }

    try {
      // Determine provider for cache key
      const provider = riskAssessment.score >= 0.5 ? 'blocked' : 
                      riskAssessment.score >= 0.25 ? 'paypal' : 'stripe';
      
      // Generate cache key based on risk pattern (not sensitive data)
      const cacheKey = this.generateCacheKey(riskAssessment, provider);
      
      // Check cache first
      const cachedResponse = this.getCachedResponse(cacheKey);
      if (cachedResponse) {
        logger.info('Cache HIT: Using cached AI explanation', { 
          cacheKey,
          riskScore: riskAssessment.score,
          provider 
        });
        return cachedResponse;
      }
      
      logger.info('Cache MISS: Generating new AI explanation', { 
        cacheKey,
        riskScore: riskAssessment.score,
        factorCount: riskAssessment.factors.length,
        provider
      });

      const prompt = this.buildPrompt(riskAssessment, chargeAmount, userEmail, paymentSource);

      const result = await Promise.race([
        this.model.generateContent(prompt),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI request timeout')), 5000)
        )
      ]);

      const response = result.response;
      const aiExplanation = response.text();

      if (!aiExplanation || aiExplanation.trim().length === 0) {
        throw new Error('Empty AI response');
      }

      // Cache the response
      this.setCachedResponse(cacheKey, aiExplanation.trim());

      logger.info('AI explanation generated and cached successfully', {
        cacheKey,
        enhancedLength: aiExplanation.length,
        provider,
        cacheSize: this.promptCache.size
      });

      return aiExplanation.trim();

    } catch (error) {
      logger.warn('Failed to generate AI explanation, using fallback', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return this.generateFallbackExplanation(riskAssessment);
    }
  }

  /**
   * Build prompt for Gemini AI
   */
  private buildPrompt(
    riskAssessment: FraudRiskAssessment, 
    amount: number, 
    _email: string,
    _source: string
  ): string {
    const riskLevel = this.getRiskLevel(riskAssessment.score);
    const provider = riskAssessment.score >= 0.5 ? 'blocked' : 'Stripe';
    
    const keyFactors = riskAssessment.factors
      .filter(f => f.impact !== 'low')
      .map(f => f.type.replace('_', ' '))
      .join(' and ');

    return `Generate a concise, single-sentence explanation for this payment decision.

Payment Details:
- Amount: $${amount}
- Risk Score: ${riskAssessment.score.toFixed(1)} (${riskLevel.toLowerCase()} risk)
- Provider: ${provider}
- Key risk factors: ${keyFactors || 'none'}

Example format: "This payment was routed to Stripe due to a low risk score with no concerning factors detected."

Rules:
1. Start with "This payment was"
2. State the routing decision (approved/blocked/routed to provider)
3. Mention the risk level
4. Briefly list key risk factors if any and with values
5. Maximum 25 words
6. Single sentence only

Generate explanation:`;
  }

  /**
   * Generate fallback explanation when AI is unavailable
   */
  private generateFallbackExplanation(riskAssessment: FraudRiskAssessment): string {
    const threshold = Number(process.env.FRAUD_THRESHOLD) || 0.5;
    const provider = riskAssessment.score >= threshold ? 'blocked' : 'routed to Stripe';
    const riskLevel = riskAssessment.score < 0.3 ? 'low' : riskAssessment.score < 0.7 ? 'medium' : 'high';
    
    const keyFactors = riskAssessment.factors
      .filter(f => f.impact !== 'low')
      .map(f => {
        if (f.type === 'amount') {
          return `large amount ($${f.value})`;
        } else if (f.type === 'email_domain') {
          return `suspicious domain (${f.value})`;
        }
        // This should never happen with current risk factors
        return f.type;
      })
      .join(' and ');

    if (keyFactors) {
      return `This payment was ${provider} due to ${riskLevel} risk score based on ${keyFactors}.`;
    } else {
      return `This payment was ${provider} due to ${riskLevel} risk score with no concerning factors detected.`;
    }
  }

  /**
   * Convert risk score to risk level
   */
  private getRiskLevel(score: number): string {
    if (score < 0.2) return 'Low';
    if (score < 0.5) return 'Medium';
    if (score < 0.8) return 'High';
    return 'Very High';
  }

  /**
   * Generate cache key based on provider, risk score, and risk factors
   * Format: ${provider}-${riskScore.toFixed(1)}-${riskFactors.sort().join(',')}
   */
  private generateCacheKey(riskAssessment: FraudRiskAssessment, provider: string): string {
    const riskScore = riskAssessment.score.toFixed(1);
    const riskFactors = riskAssessment.factors
      .map(f => f.type)
      .sort()
      .join(',');
    
    return `${provider}-${riskScore}-${riskFactors}`;
  }

  /**
   * Get cached response if available and not expired
   */
  private getCachedResponse(cacheKey: string): string | null {
    const entry = this.promptCache.get(cacheKey);
    if (!entry) {
      logger.debug('Cache entry not found', { cacheKey });
      return null;
    }

    const now = Date.now();
    const age = now - entry.timestamp;
    
    if (age > this.cacheExpiryMs) {
      logger.debug('Cache entry expired, removing', { 
        cacheKey, 
        ageMinutes: Math.round(age / (60 * 1000)) 
      });
      this.promptCache.delete(cacheKey);
      return null;
    }

    logger.debug('Cache entry found and valid', { 
      cacheKey, 
      ageMinutes: Math.round(age / (60 * 1000)) 
    });
    return entry.response;
  }

  /**
   * Set cached response with logging
   */
  private setCachedResponse(cacheKey: string, response: string): void {
    this.promptCache.set(cacheKey, {
      response,
      timestamp: Date.now()
    });

    logger.debug('Response cached successfully', { 
      cacheKey, 
      responseLength: response.length,
      cacheSize: this.promptCache.size 
    });

    // Clean expired entries periodically when cache gets large
    if (this.promptCache.size > 100) {
      const sizeBefore = this.promptCache.size;
      this.cleanExpiredCache();
      const sizeAfter = this.promptCache.size;
      
      if (sizeBefore !== sizeAfter) {
        logger.info('Cache cleanup completed', { 
          entriesRemoved: sizeBefore - sizeAfter,
          cacheSize: sizeAfter 
        });
      }
    }
  }

  /**
   * Clean expired cache entries
   */
  private cleanExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.promptCache.entries()) {
      if (now - entry.timestamp > this.cacheExpiryMs) {
        this.promptCache.delete(key);
      }
    }
  }

  /**
   * Health check for Gemini service
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isAvailable || !this.model) {
      return false;
    }

    try {
      // Test with a simple prompt
      const testPrompt = 'Respond with "OK" if you can process this message.';
      const result = await Promise.race([
        this.model.generateContent(testPrompt),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Health check timeout')), 3000)
        )
      ]);

      const response = result?.response?.text();
      const isHealthy = response && response.includes('OK');
      
      if (isHealthy) {
        logger.debug('Gemini health check passed', { model: this.currentModel });
      }
      
      return isHealthy;
    } catch (error) {
      logger.error('Gemini health check failed', { 
        model: this.currentModel,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }

  /**
   * Get service availability status
   */
  isServiceAvailable(): boolean {
    return this.isAvailable;
  }
}

// Export singleton instance
export const geminiService = new GeminiService(); 