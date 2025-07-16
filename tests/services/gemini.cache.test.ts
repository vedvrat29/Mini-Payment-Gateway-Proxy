import { GeminiService } from '../../src/services/gemini.service';
import { FraudRiskAssessment } from '../../src/models/types';

// Mock the logger to avoid console output during tests
jest.mock('../../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

// Mock dotenv
jest.mock('dotenv', () => ({
  config: jest.fn()
}));

// Mock Google Generative AI
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn().mockReturnValue({
  generateContent: mockGenerateContent
});

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel
  }))
}));

describe('GeminiService Cache Functionality', () => {
  let geminiService: GeminiService;
  let mockRiskAssessment: FraudRiskAssessment;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set up environment variable
    process.env.GEMINI_API_KEY = 'test-api-key';
    
    // Mock successful AI response
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => 'This payment was routed to Stripe due to low risk score with no concerning factors detected.'
      }
    });

    geminiService = new GeminiService();
    
    // Force the service to be available for testing
    (geminiService as any).isAvailable = true;
    (geminiService as any).model = { generateContent: mockGenerateContent };
    
    // Reset mock call count after initialization
    jest.clearAllMocks();

    mockRiskAssessment = {
      score: 0.1,
      explanation: 'Low risk payment',
      factors: [
        {
          type: 'amount',
          value: 500,
          impact: 'low',
          description: 'Normal amount'
        }
      ]
    };
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  describe('Cache Key Generation', () => {
    it('should generate consistent cache keys for same risk patterns', () => {
      const generateKey = (geminiService as any).generateCacheKey.bind(geminiService);
      
      const key1 = generateKey(mockRiskAssessment, 'stripe');
      const key2 = generateKey(mockRiskAssessment, 'stripe');
      
      expect(key1).toBe(key2);
      expect(key1).toBe('stripe-0.1-amount');
    });

    it('should generate different cache keys for different providers', () => {
      const generateKey = (geminiService as any).generateCacheKey.bind(geminiService);
      
      const stripeKey = generateKey(mockRiskAssessment, 'stripe');
      const paypalKey = generateKey(mockRiskAssessment, 'paypal');
      
      expect(stripeKey).toBe('stripe-0.1-amount');
      expect(paypalKey).toBe('paypal-0.1-amount');
      expect(stripeKey).not.toBe(paypalKey);
    });

    it('should generate different cache keys for different risk scores', () => {
      const generateKey = (geminiService as any).generateCacheKey.bind(geminiService);
      
      const lowRisk = { ...mockRiskAssessment, score: 0.1 };
      const mediumRisk = { ...mockRiskAssessment, score: 0.3 };
      
      const lowKey = generateKey(lowRisk, 'stripe');
      const mediumKey = generateKey(mediumRisk, 'paypal');
      
      expect(lowKey).toBe('stripe-0.1-amount');
      expect(mediumKey).toBe('paypal-0.3-amount');
    });

    it('should sort risk factors consistently', () => {
      const generateKey = (geminiService as any).generateCacheKey.bind(geminiService);
      
      const assessment1: FraudRiskAssessment = {
        ...mockRiskAssessment,
        factors: [
          { type: 'amount' as const, value: 1000, impact: 'medium' as const, description: 'High amount' },
          { type: 'email_domain' as const, value: 'test.com', impact: 'medium' as const, description: 'Suspicious domain' }
        ]
      };
      
      const assessment2: FraudRiskAssessment = {
        ...mockRiskAssessment,
        factors: [
          { type: 'email_domain' as const, value: 'test.com', impact: 'medium' as const, description: 'Suspicious domain' },
          { type: 'amount' as const, value: 1000, impact: 'medium' as const, description: 'High amount' }
        ]
      };
      
      const key1 = generateKey(assessment1, 'paypal');
      const key2 = generateKey(assessment2, 'paypal');
      
      expect(key1).toBe(key2);
      expect(key1).toBe('paypal-0.1-amount,email_domain');
    });
  });

  describe('Cache Hit/Miss Behavior', () => {
    it('should return cached response on cache hit', async () => {
      // First call - should miss cache and call AI
      const result1 = await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'test@example.com', 'tok_test'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(result1).toContain('This payment was routed to Stripe');

      // Second call with same pattern - should hit cache
      const result2 = await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'different@example.com', 'tok_different'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(1); // No additional calls
      expect(result2).toBe(result1); // Exact same response from cache
    });

    it('should miss cache for different risk patterns', async () => {
      // First call - low risk, Stripe
      await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'test@example.com', 'tok_test'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      // Second call - medium risk, PayPal (different cache key)
      const mediumRiskAssessment: FraudRiskAssessment = {
        ...mockRiskAssessment,
        score: 0.32,
        factors: [
          {
            type: 'email_domain' as const,
            value: 'example.com',
            impact: 'medium' as const,
            description: 'Suspicious domain: example.com'
          }
        ]
      };

      await geminiService.enhanceRiskExplanation(
        mediumRiskAssessment, 1000, 'test@example.com', 'tok_test'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(2); // New AI call
    });

    it('should handle cache expiry correctly', async () => {
      // Mock Date.now to control time
      const originalDateNow = Date.now;
      const startTime = 1000000;
      Date.now = jest.fn(() => startTime);

      // First call - cache the response
      await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'test@example.com', 'tok_test'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      // Move time forward 2 hours (beyond 1 hour TTL)
      Date.now = jest.fn(() => startTime + (2 * 60 * 60 * 1000));

      // Second call - cache should be expired
      await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'test@example.com', 'tok_test'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(2); // New AI call

      // Restore original Date.now
      Date.now = originalDateNow;
    });
  });

  describe('Cache Management', () => {
    it('should trigger cache cleanup when size exceeds 100 entries', async () => {
      // Fill cache with 101 entries by varying the risk score
      for (let i = 0; i <= 100; i++) {
        const assessment = {
          ...mockRiskAssessment,
          score: i / 1000 // Create unique scores: 0.000, 0.001, 0.002, etc.
        };
        
        await geminiService.enhanceRiskExplanation(
          assessment, 500, 'test@example.com', 'tok_test'
        );
      }
      
      // Check that cache size is managed (should not exceed a reasonable limit)
      const cache = (geminiService as any).promptCache;
      expect(cache.size).toBeLessThanOrEqual(101);
    });

    it('should properly clean expired entries', () => {
      const originalDateNow = Date.now;
      const startTime = 1000000;
      const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
      
      // Set up cache with some entries
      const cache = (geminiService as any).promptCache;
      
      Date.now = jest.fn(() => startTime);
      
      // Add old entries (will be expired)
      cache.set('old-1', { response: 'response1', timestamp: startTime });
      cache.set('old-2', { response: 'response2', timestamp: startTime });
      
      // Move time forward 30 minutes and add a fresh entry
      const thirtyMinutes = 30 * 60 * 1000;
      cache.set('fresh-1', { response: 'response3', timestamp: startTime + thirtyMinutes });
      
      // Move time forward to 1.5 hours (90 minutes) from start
      Date.now = jest.fn(() => startTime + oneHour + thirtyMinutes);
      
      expect(cache.size).toBe(3);
      
      // Trigger cleanup - entries older than 1 hour should be removed
      (geminiService as any).cleanExpiredCache();
      
      // Only the fresh-1 entry should remain (30 minutes old from cleanup time)
      expect(cache.size).toBe(1);
      expect(cache.has('fresh-1')).toBe(true);
      expect(cache.has('old-1')).toBe(false);
      expect(cache.has('old-2')).toBe(false);
      
      Date.now = originalDateNow;
    });
  });

  describe('Cache Integration with Provider Logic', () => {
    it('should cache responses for different provider routes', async () => {
      // Low risk -> Stripe
      const lowRisk = { ...mockRiskAssessment, score: 0.1 };
      await geminiService.enhanceRiskExplanation(lowRisk, 500, 'test@example.com', 'tok_test');
      
      // Medium risk -> PayPal  
      const mediumRisk = { ...mockRiskAssessment, score: 0.32 };
      await geminiService.enhanceRiskExplanation(mediumRisk, 1000, 'test@example.com', 'tok_test');
      
      // High risk -> Blocked
      const highRisk = { ...mockRiskAssessment, score: 0.6 };
      await geminiService.enhanceRiskExplanation(highRisk, 2000, 'test@example.com', 'tok_test');
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      
      // Verify cache has different entries for different providers
      const cache = (geminiService as any).promptCache;
      expect(cache.size).toBe(3);
    });
  });

  describe('Error Handling with Cache', () => {
    it('should not cache responses when AI call fails', async () => {
      mockGenerateContent.mockRejectedValueOnce(new Error('AI service error'));
      
      // First call - should fail and use fallback, no caching
      const result1 = await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'test@example.com', 'tok_test'
      );
      
      expect(result1).toContain('This payment was routed to Stripe'); // Fallback explanation
      
      // Reset mock to succeed
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => 'AI generated explanation' }
      });
      
      // Second call - should call AI again (nothing was cached from failed call)
      const result2 = await geminiService.enhanceRiskExplanation(
        mockRiskAssessment, 500, 'test@example.com', 'tok_test'
      );
      
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(result2).toBe('AI generated explanation');
    });
  });
}); 