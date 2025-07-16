import { ChargeRequest, FraudRiskAssessment, RiskFactor, Provider } from '../models/types';
import logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// Dynamic fraud rules configuration interface
interface RuleCondition {
  // For amount rules
  operator?: '>=' | '<=' | '>' | '<' | '=' | 'length<' | 'length>' | 'length=';
  value?: number;
  
  // For domain/currency/pattern rules
  domains?: string[];
  currencies?: string[];
  patterns?: string[];
  
  // Common properties
  score: number;
  impact: 'low' | 'medium' | 'high';
  description: string;
}

interface FraudRule {
  type: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
}

interface FraudConfig {
  fraudDetection: {
    providerThresholds: {
      stripe: number;
      paypal: number;
      blocked: number;
    };
    rules: FraudRule[];
    riskLevels: {
      [key: string]: {
        max: number;
        label: string;
      };
    };
  };
}

/**
 * Dynamic fraud detection service with configurable rule-based engine
 */
export class FraudService {
  private readonly config: FraudConfig;
  private readonly rules: Map<string, FraudRule>;

  constructor() {
    // Load config from file with fallback to defaults
    this.config = this.loadFraudConfig();
    
    // Build rules map for efficient lookup
    this.rules = new Map();
    this.config.fraudDetection.rules
      .filter(rule => rule.enabled)
      .forEach(rule => this.rules.set(rule.type, rule));

    logger.info('Dynamic fraud service initialized', {
      totalRules: this.config.fraudDetection.rules.length,
      enabledRules: this.rules.size,
      ruleTypes: Array.from(this.rules.keys()),
      providerThresholds: this.config.fraudDetection.providerThresholds
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
      
      logger.info('Dynamic fraud rules loaded from config file', { 
        configPath,
        rulesCount: config.fraudDetection.rules.length
      });
      return config;
    } catch (error) {
      logger.warn('Failed to load fraud rules config, using minimal defaults', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Return minimal default configuration
      return {
        fraudDetection: {
          providerThresholds: { stripe: 0.25, paypal: 0.5, blocked: 1.0 },
          rules: [
            {
              type: 'amount',
              name: 'Basic Amount Risk',
              enabled: true,
              conditions: [
                { operator: '>=', value: 500, score: 0.2, impact: 'high', description: 'Large amount' }
              ]
            }
          ],
          riskLevels: {
            low: { max: 0.2, label: 'Low' },
            medium: { max: 0.5, label: 'Medium' },
            high: { max: 0.8, label: 'High' },
            veryHigh: { max: 1.0, label: 'Very High' }
          }
        }
      };
    }
  }

  /**
   * Calculate fraud risk score using dynamic rule evaluation
   */
  async calculateRiskScore(request: ChargeRequest): Promise<number> {
    logger.info('Calculating fraud risk using dynamic rules', { 
      amount: request.amount,
      currency: request.currency,
      email: request.email
    });

    let totalRiskScore = 0;
    const appliedRules: string[] = [];

    // Evaluate all enabled rules dynamically
    for (const [ruleType, rule] of this.rules) {
      const ruleResult = this.evaluateRule(rule, request);
      if (ruleResult.score > 0) {
        totalRiskScore += ruleResult.score;
        appliedRules.push(`${ruleType}:${ruleResult.score}`);
      }
    }

    // Normalize risk score to 0-1 range and round to 1 decimal
    const normalizedScore = Math.min(totalRiskScore, 1.0);
    const roundedScore = Math.round(normalizedScore * 10) / 10;

    logger.info('Dynamic risk assessment completed', {
      email: request.email,
      riskScore: roundedScore,
      appliedRules,
      totalRulesEvaluated: this.rules.size
    });

    return roundedScore;
  }

  /**
   * Determine payment provider based on dynamic thresholds
   */
  determineProvider(riskScore: number): Provider {
    const thresholds = this.config.fraudDetection.providerThresholds;
    
    if (riskScore >= thresholds.paypal) {
      return 'blocked';
    } else if (riskScore >= thresholds.stripe) {
      return 'paypal';
    } else {
      return 'stripe';
    }
  }

  /**
   * Get risk factors using dynamic rule evaluation
   */
  async getRiskFactors(request: ChargeRequest): Promise<string[]> {
    const riskFactors: string[] = [];

    // Evaluate all rules and collect descriptions
    for (const [, rule] of this.rules) {
      const ruleResult = this.evaluateRule(rule, request);
      if (ruleResult.score > 0 && ruleResult.description) {
        riskFactors.push(ruleResult.description);
      }
    }

    return riskFactors;
  }

  /**
   * Get complete fraud risk assessment using dynamic rules
   */
  async getFullRiskAssessment(request: ChargeRequest): Promise<FraudRiskAssessment> {
    const riskFactors: RiskFactor[] = [];
    let totalRiskScore = 0;

    // Evaluate all enabled rules
    for (const [, rule] of this.rules) {
      const ruleResult = this.evaluateRule(rule, request);
      if (ruleResult.score > 0) {
        riskFactors.push({
          type: rule.type,
          value: ruleResult.value,
          impact: ruleResult.impact,
          description: ruleResult.description
        });
        totalRiskScore += ruleResult.score;
      }
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

  /**
   * Dynamic rule evaluation engine
   */
  private evaluateRule(rule: FraudRule, request: ChargeRequest): { score: number; value: any; impact: 'low' | 'medium' | 'high'; description: string } {
    for (const condition of rule.conditions) {
      const result = this.evaluateCondition(rule.type, condition, request);
      if (result.matches) {
        return {
          score: condition.score,
          value: result.value,
          impact: condition.impact,
          description: `${condition.description}: ${result.value}`
        };
      }
    }
    
    return { score: 0, value: null, impact: 'low', description: '' };
  }

  /**
   * Evaluate individual rule condition
   */
  private evaluateCondition(ruleType: string, condition: RuleCondition, request: ChargeRequest): { matches: boolean; value: any } {
    switch (ruleType) {
      case 'amount':
        return this.evaluateAmountCondition(condition, request.amount);
      
      case 'email_domain':
        const domain = request.email.split('@')[1]?.toLowerCase() || '';
        return this.evaluateEmailDomainCondition(condition, domain);
      
      case 'currency':
        return this.evaluateCurrencyCondition(condition, request.currency);
      
      case 'source':
        return this.evaluateSourceCondition(condition, request.source);
      
      default:
        logger.warn('Unknown rule type', { ruleType });
        return { matches: false, value: null };
    }
  }

  /**
   * Evaluate amount-based conditions
   */
  private evaluateAmountCondition(condition: RuleCondition, amount: number): { matches: boolean; value: any } {
    if (!condition.operator || condition.value === undefined) {
      return { matches: false, value: amount };
    }

    let matches = false;
    switch (condition.operator) {
      case '>=':
        matches = amount >= condition.value;
        break;
      case '<=':
        matches = amount <= condition.value;
        break;
      case '>':
        matches = amount > condition.value;
        break;
      case '<':
        matches = amount < condition.value;
        break;
      case '=':
        matches = amount === condition.value;
        break;
    }

    return { matches, value: `$${amount}` };
  }

  /**
   * Evaluate email domain conditions
   */
  private evaluateEmailDomainCondition(condition: RuleCondition, domain: string): { matches: boolean; value: any } {
    // Check domain lists
    if (condition.domains) {
      const matches = condition.domains.some(suspiciousDomain => {
        if (suspiciousDomain.startsWith('.')) {
          return domain.endsWith(suspiciousDomain);
        }
        return domain === suspiciousDomain;
      });
      if (matches) {
        return { matches: true, value: domain };
      }
    }

    // Check patterns
    if (condition.patterns) {
      const matches = condition.patterns.some(pattern => domain.includes(pattern));
      if (matches) {
        return { matches: true, value: domain };
      }
    }

    return { matches: false, value: domain };
  }

  /**
   * Evaluate currency conditions
   */
  private evaluateCurrencyCondition(condition: RuleCondition, currency: string): { matches: boolean; value: any } {
    if (condition.currencies) {
      const matches = condition.currencies.includes(currency);
      return { matches, value: currency };
    }
    return { matches: false, value: currency };
  }

  /**
   * Evaluate payment source conditions
   */
  private evaluateSourceCondition(condition: RuleCondition, source: string): { matches: boolean; value: any } {
    // Check patterns
    if (condition.patterns) {
      const matches = condition.patterns.some(pattern => source.toLowerCase().includes(pattern));
      if (matches) {
        return { matches: true, value: source };
      }
    }

    // Check length conditions
    if (condition.operator && condition.value !== undefined) {
      let matches = false;
      switch (condition.operator) {
        case 'length<':
          matches = source.length < condition.value;
          break;
        case 'length>':
          matches = source.length > condition.value;
          break;
        case 'length=':
          matches = source.length === condition.value;
          break;
      }
      if (matches) {
        return { matches: true, value: `${source} (${source.length} chars)` };
      }
    }

    return { matches: false, value: source };
  }

  /**
   * Generate risk explanation using dynamic risk levels
   */
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

  /**
   * Get risk level label using dynamic configuration
   */
  private getRiskLevel(score: number): string {
    const levels = this.config.fraudDetection.riskLevels;
    
    for (const [, level] of Object.entries(levels)) {
      if (score <= level.max) {
        return level.label;
      }
    }
    
    return 'Very High';
  }

  /**
   * Health check for the dynamic fraud service
   */
  healthCheck(): boolean {
    try {
      // Test dynamic rule evaluation
      const testRequest: ChargeRequest = {
        amount: 100,
        currency: 'USD',
        source: 'tok_test',
        email: 'test@example.com'
      };
      
      const testResult = this.evaluateRule(
        this.rules.get('amount') || { type: 'amount', name: 'test', enabled: true, conditions: [] },
        testRequest
      );
      
      return typeof testResult.score === 'number' && testResult.score >= 0;
    } catch (error) {
      logger.error('Dynamic fraud service health check failed', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }
}

// Export singleton instance
export const fraudService = new FraudService(); 