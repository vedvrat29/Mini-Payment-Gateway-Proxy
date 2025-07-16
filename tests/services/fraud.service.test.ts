import { fraudService } from '../../src/services/fraud.service';
import { ChargeRequest } from '../../src/models/types';

describe('FraudService', () => {
  describe('calculateRiskScore', () => {
    it('should return low risk score for normal payment', async () => {
      const request: ChargeRequest = {
        amount: 100,
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@gmail.com'
      };

      const riskScore = await fraudService.calculateRiskScore(request);

      expect(riskScore).toBe(0.0); // No risk factors
    });

    it('should return higher risk score for large amount', async () => {
      const request: ChargeRequest = {
        amount: 600, // >= 500 triggers amount risk
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@gmail.com'
      };

      const riskScore = await fraudService.calculateRiskScore(request);

      expect(riskScore).toBe(0.2); // Amount risk only
    });

    it('should return higher risk score for suspicious email domain', async () => {
      const request: ChargeRequest = {
        amount: 100,
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@example.com' // Suspicious domain
      };

      const riskScore = await fraudService.calculateRiskScore(request);

      expect(riskScore).toBe(0.3); // Domain risk only (rounded from 0.32)
    });

    it('should handle normal email domains correctly', async () => {
      const request: ChargeRequest = {
        amount: 100,
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@gmail.com' // Normal domain
      };

      const riskScore = await fraudService.calculateRiskScore(request);

      expect(riskScore).toBe(0.0); // No risk factors
    });

    it('should combine multiple risk factors', async () => {
      const request: ChargeRequest = {
        amount: 600, // Amount risk (0.2)
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@example.com' // Domain risk (0.32)
      };

      const riskScore = await fraudService.calculateRiskScore(request);

      expect(riskScore).toBe(0.5); // 0.2 + 0.32 = 0.52 rounded to 0.5
    });
  });

  describe('determineProvider', () => {
    it('should return stripe for low risk score', () => {
      const provider = fraudService.determineProvider(0.2);
      expect(provider).toBe('stripe'); // < 0.25
    });

    it('should return paypal for medium risk score', () => {
      const provider = fraudService.determineProvider(0.3);
      expect(provider).toBe('paypal'); // 0.25 <= score < 0.5
    });

    it('should return blocked for high risk score', () => {
      const provider = fraudService.determineProvider(0.7);
      expect(provider).toBe('blocked'); // >= 0.5
    });

    it('should handle threshold boundaries correctly', () => {
      // Test exact boundaries
      expect(fraudService.determineProvider(0.24)).toBe('stripe');
      expect(fraudService.determineProvider(0.25)).toBe('paypal');
      expect(fraudService.determineProvider(0.49)).toBe('paypal');
      expect(fraudService.determineProvider(0.5)).toBe('blocked');
    });
  });

  describe('getRiskFactors', () => {
    it('should return risk factors for high-risk payment', async () => {
      const request: ChargeRequest = {
        amount: 600, // Large amount
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@test.com' // Suspicious domain
      };

      const factors = await fraudService.getRiskFactors(request);

      expect(factors).toHaveLength(2);
      expect(factors).toContain('Large amount: $600');
      expect(factors.some(f => f.includes('test.com'))).toBe(true);
    });

    it('should return empty array for low-risk payment', async () => {
      const request: ChargeRequest = {
        amount: 100, // Normal amount
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@gmail.com' // Normal domain
      };

      const factors = await fraudService.getRiskFactors(request);

      expect(factors).toHaveLength(0);
    });

    it('should return single factor for amount risk only', async () => {
      const request: ChargeRequest = {
        amount: 800, // Large amount only
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@gmail.com' // Normal domain
      };

      const factors = await fraudService.getRiskFactors(request);

      expect(factors).toHaveLength(1);
      expect(factors[0]).toContain('Large amount: $800');
    });

    it('should return single factor for domain risk only', async () => {
      const request: ChargeRequest = {
        amount: 100, // Normal amount
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@example.com' // Suspicious domain only
      };

      const factors = await fraudService.getRiskFactors(request);

      expect(factors).toHaveLength(1);
      expect(factors[0]).toContain('Suspicious test domain: example.com');
    });
  });

  describe('getFullRiskAssessment', () => {
    it('should return complete risk assessment', async () => {
      const request: ChargeRequest = {
        amount: 600,
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@example.com'
      };

      const assessment = await fraudService.getFullRiskAssessment(request);

      expect(assessment.score).toBe(0.5);
      expect(assessment.factors).toHaveLength(2);
      expect(assessment.explanation).toContain('Key concerns');
    });

    it('should handle zero risk correctly', async () => {
      const request: ChargeRequest = {
        amount: 100,
        currency: 'USD',
        source: 'card_1234567890',
        email: 'user@gmail.com'
      };

      const assessment = await fraudService.getFullRiskAssessment(request);

      expect(assessment.score).toBe(0.0);
      expect(assessment.factors).toHaveLength(0);
      expect(assessment.explanation).toContain('no concerning factors');
    });
  });

  describe('healthCheck', () => {
    it('should return true for healthy service', () => {
      const isHealthy = fraudService.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });
}); 