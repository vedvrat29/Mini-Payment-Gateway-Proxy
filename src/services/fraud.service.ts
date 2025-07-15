import { ChargeRequest, FraudRiskAssessment, RiskFactor, Provider } from '../models/types';
import logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// Fraud rules configuration interface - simplified for amount and email_domain only
interface FraudConfig {
  fraudDetection: {
    thresholds: {
      maxSafeAmount: number;
      fraudThreshold: number;
    };
    suspiciousDomains: string[];
    riskScores: {
      amountRisk: {
        moderateMultiplier: number;
        moderateScore: number;
        highMultiplier: number;
        highScore: number;
        veryHighMultiplier: number;
        veryHighScore: number;
      };
      emailRisk: {
        suspiciousDomainScore: number;
        temporaryEmailScore: number;
      };
    };
    patterns: {
      temporaryEmailKeywords: string[];
    };
  };
}

/**
 * Fraud detection service with configurable risk rules
 */
export class FraudService {
  private readonly config: FraudConfig;
  private readonly maxSafeAmount: number;
  private readonly suspiciousDomains: Set<string>;
  private readonly fraudThreshold: number;

  constructor() {
    // Load config from file with fallback to defaults
    this.config = this.loadFraudConfig();
    
    // Environment variables can override config file values
    this.maxSafeAmount =  this.config.fraudDetection.thresholds.maxSafeAmount;
    this.fraudThreshold = this.config.fraudDetection.thresholds.fraudThreshold;
    
    this.suspiciousDomains = new Set(this.config.fraudDetection.suspiciousDomains);

    logger.info('Fraud service initialized with simple risk factors', {
      maxSafeAmount: this.maxSafeAmount,
      fraudThreshold: this.fraudThreshold,
      suspiciousDomainsCount: this.suspiciousDomains.size,
      riskFactors: ['amount', 'email_domain']
    });
  }

  /**
   * Load fraud configuration from file
   */
  private loadFraudConfig(): FraudConfig {
    try {
      const configPath = path.resolve(process.cwd(), 'config', 'fraud-rules.json');
      const configFile = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configFile) as FraudConfig;
      
      logger.info('Fraud rules loaded from config file', { configPath });
      return config;
    } catch (error) {
      logger.warn('Failed to load fraud rules config, using defaults', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Return default configuration as fallback - simplified for amount and email_domain only
      return {
        fraudDetection: {
          thresholds: { maxSafeAmount: 1000, fraudThreshold: 0.5 },
          suspiciousDomains: ['test.com', 'temp.com', '.ru'],
          riskScores: {
            amountRisk: { moderateMultiplier: 1.0, moderateScore: 0.1, highMultiplier: 3.0, highScore: 0.25, veryHighMultiplier: 10.0, veryHighScore: 0.4 },
            emailRisk: { suspiciousDomainScore: 0.3, temporaryEmailScore: 0.25 }
          },
          patterns: { temporaryEmailKeywords: ['temp', 'disposable', 'fake'] }
        }
      };
    }
  }

  /**
   * Calculate fraud risk score for a charge request
   * Uses simple heuristics: large amount + suspicious domain
   */
  async calculateRiskScore(request: ChargeRequest): Promise<number> {
    logger.info('Calculating fraud risk', { 
      amount: request.amount,
      email: request.email
    });

    let totalRiskScore = 0;

    // Amount-based risk assessment
    const amountRisk = this.assessAmountRisk(request.amount);
    totalRiskScore += amountRisk.score;

    // Email domain risk assessment
    const emailRisk = this.assessEmailRisk(request.email);
    totalRiskScore += emailRisk.score;

    // Normalize risk score to 0-1 range and round to 1 decimal
    const normalizedScore = Math.min(totalRiskScore, 1.0);
    const roundedScore = Math.round(normalizedScore * 10) / 10;

    logger.info('Risk assessment completed', {
      email: request.email,
      riskScore: roundedScore
    });

    return roundedScore;
  }

  /**
   * Determine payment provider based on risk score
   * Low risk (< 0.25) → Stripe
   * Moderate risk (0.25 - 0.5) → PayPal  
   * High risk (≥ 0.5) → Blocked
   */
  determineProvider(riskScore: number): Provider {
    if (riskScore >= this.fraudThreshold) {
      // Block submission if risk score ≥ 0.5
      return 'blocked';
    } else if (riskScore >= 0.25) {
      // Route to PayPal for moderate risk
      return 'paypal';
    } else {
      // Route to Stripe for low risk
      return 'stripe';
    }
  }

  /**
   * Get risk factors for a charge request
   * Simple heuristics: large amount + suspicious domain
   */
  async getRiskFactors(request: ChargeRequest): Promise<string[]> {
    const riskFactors: string[] = [];

    // Amount-based risk assessment
    const amountRisk = this.assessAmountRisk(request.amount);
    if (amountRisk.score > 0) {
      riskFactors.push(amountRisk.description);
    }

    // Email domain risk assessment
    const emailRisk = this.assessEmailRisk(request.email);
    if (emailRisk.score > 0) {
      riskFactors.push(emailRisk.description);
    }

    return riskFactors;
  }

  /**
   * Get complete fraud risk assessment (for AI integration)
   * Simple heuristics: large amount + suspicious domain
   */
  async getFullRiskAssessment(request: ChargeRequest): Promise<FraudRiskAssessment> {
    const riskFactors: RiskFactor[] = [];
    let totalRiskScore = 0;

    // Amount-based risk assessment
    const amountRisk = this.assessAmountRisk(request.amount);
    if (amountRisk.score > 0) {
      riskFactors.push(amountRisk);
      totalRiskScore += amountRisk.score;
    }

    // Email domain risk assessment
    const emailRisk = this.assessEmailRisk(request.email);
    if (emailRisk.score > 0) {
      riskFactors.push(emailRisk);
      totalRiskScore += emailRisk.score;
    }

    // Normalize risk score to 0-1 range and round to 1 decimal
    const normalizedScore = Math.min(totalRiskScore, 1.0);
    const roundedScore = Math.round(normalizedScore * 10) / 10;
    
    const explanation = this.generateRiskExplanation(roundedScore, riskFactors);

    return {
      score: roundedScore,
      explanation,
      factors: riskFactors
    };
  }

  private assessAmountRisk(amount: number): RiskFactor & { score: number } {
    let score = 0;
    let impact: 'low' | 'medium' | 'high' = 'low';
    let description = '';

    // Simple logic: amounts >= 500 get 0.2 risk score
    if (amount >= this.maxSafeAmount) {
      score = 0.2;
      impact = 'high';
      description = `Large amount: $${amount}`;
    }

    return {
      type: 'amount',
      value: amount,
      impact,
      description: description || `Normal amount: $${amount}`,
      score
    };
  }

  private assessEmailRisk(email: string): RiskFactor & { score: number } {
    const domain = email.split('@')[1]?.toLowerCase() || '';
    let score = 0;
    let impact: 'low' | 'medium' | 'high' = 'low';
    let description = '';
    const emailConfig = this.config.fraudDetection.riskScores.emailRisk;

    // Check for suspicious domains
    const isSuspicious = Array.from(this.suspiciousDomains).some(suspiciousDomain => {
      if (suspiciousDomain.startsWith('.')) {
        return domain.endsWith(suspiciousDomain);
      }
      return domain === suspiciousDomain;
    });

    if (isSuspicious) {
      score = emailConfig.suspiciousDomainScore;
      impact = 'medium';
      description = `Suspicious email domain: ${domain}`;
    }

    // Check for temporary/disposable email patterns
    const tempKeywords = this.config.fraudDetection.patterns.temporaryEmailKeywords;
    const isTemporary = tempKeywords.some(keyword => domain.includes(keyword));
    
    if (isTemporary) {
      score = Math.max(score, emailConfig.temporaryEmailScore);
      impact = 'medium';
      description = `Likely temporary email: ${domain}`;
    }

    return {
      type: 'email_domain',
      value: domain,
      impact,
      description: description || `Normal email domain: ${domain}`,
      score
    };
  }





  private generateRiskExplanation(score: number, factors: RiskFactor[]): string {
    const riskLevel = this.getRiskLevel(score);
    
    if (factors.length === 0) {
      return `${riskLevel} risk transaction with no concerning factors detected.`;
    }

    const concerningFactors = factors.filter(f => f.impact !== 'low');
    
    if (concerningFactors.length === 0) {
      return `${riskLevel} risk transaction with minor risk factors: ${factors.map(f => f.type).join(', ')}.`;
    }

    const factorDescriptions = concerningFactors
      .map(f => f.description)
      .join('; ');

    return `${riskLevel} risk transaction. Key concerns: ${factorDescriptions}.`;
  }

  private getRiskLevel(score: number): string {
    if (score < 0.2) return 'Low';
    if (score < 0.5) return 'Medium';
    if (score < 0.8) return 'High';
    return 'Very High';
  }

  healthCheck(): boolean {
    try {
      // Test basic functionality
      const testResult = this.assessAmountRisk(100);
      return typeof testResult.score === 'number' && testResult.score >= 0;
    } catch (error) {
      logger.error('Fraud service health check failed', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }
}

// Export singleton instance
export const fraudService = new FraudService(); 