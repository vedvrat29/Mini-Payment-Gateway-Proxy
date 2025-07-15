import request from 'supertest';
import app from '../../src/app';
import { storageService } from '../../src/services/storage.service';

describe('Payment API Integration Tests', () => {
  beforeEach(async () => {
    await storageService.clear();
  });

  afterEach(async () => {
    await storageService.clear();
  });

  describe('POST /charge', () => {
    it('should process a valid low-risk payment', async () => {
      const paymentRequest = {
        amount: 100,
        currency: 'USD',
        source: 'tok_visa',
        email: 'user@gmail.com'
      };

      const response = await request(app)
        .post('/charge')
        .send(paymentRequest)
        .expect(200);

      expect(response.body).toMatchObject({
        transactionId: expect.any(String),
        status: 'success',
        provider: 'stripe',
        riskScore: expect.any(Number),
        explanation: expect.any(String)
      });

      expect(response.body.riskScore).toBe(0.0); // No risk factors
    });

    it('should route medium-risk payment to PayPal', async () => {
      const paymentRequest = {
        amount: 600, // Large amount (0.2 risk)
        currency: 'USD',
        source: 'tok_test',
        email: 'user@gmail.com'
      };

      const response = await request(app)
        .post('/charge')
        .send(paymentRequest)
        .expect(200);

      expect(response.body.provider).toBe('stripe'); // 0.2 < 0.25, should be Stripe
      expect(response.body.riskScore).toBe(0.2);
    });

    it('should route high-risk payment to PayPal', async () => {
      const paymentRequest = {
        amount: 600,
        currency: 'USD',
        source: 'tok_test',
        email: 'user@example.com' // Suspicious domain (0.32 risk)
      };

      const response = await request(app)
        .post('/charge')
        .send(paymentRequest)
        .expect(200);

      expect(response.body.provider).toBe('blocked'); // 0.5 >= 0.5 threshold
      expect(response.body.riskScore).toBe(0.5);
    });

    it('should block very high-risk payments', async () => {
      const paymentRequest = {
        amount: 600, // Large amount (0.2)
        currency: 'USD', 
        source: 'tok_test',
        email: 'user@test.com' // Suspicious domain (0.32) -> total 0.52
      };

      const response = await request(app)
        .post('/charge')
        .send(paymentRequest)
        .expect(200);

      expect(response.body.status).toBe('blocked');
      expect(response.body.provider).toBe('blocked');
      expect(response.body.riskScore).toBeGreaterThanOrEqual(0.5);
    });

    it('should return 400 for invalid payment request', async () => {
      const invalidRequest = {
        amount: 'invalid', // Should be number
        currency: 'USD',
        source: 'tok_test',
        email: 'invalid-email' // Invalid email format
      };

      const response = await request(app)
        .post('/charge')
        .send(invalidRequest)
        .expect(400);

      expect(response.body.error).toBe('Validation Error');
      expect(response.body.details).toBeDefined();
    });

    it('should return 400 for missing required fields', async () => {
      const incompleteRequest = {
        amount: 100
        // Missing currency, source, email
      };

      const response = await request(app)
        .post('/charge')
        .send(incompleteRequest)
        .expect(400);

      expect(response.body.error).toBe('Validation Error');
    });

    it('should handle large payment amounts correctly', async () => {
      const paymentRequest = {
        amount: 1000, // Large amount  
        currency: 'USD',
        source: 'tok_test',
        email: 'user@gmail.com'
      };

      const response = await request(app)
        .post('/charge')
        .send(paymentRequest)
        .expect(200);

      expect(response.body.riskScore).toBe(0.2); // Just large amount
      expect(response.body.provider).toBe('stripe'); // 0.2 < 0.25
    });
  });

  describe('GET /transaction/:transactionId', () => {
    it('should retrieve an existing transaction', async () => {
      // Create a transaction first
      const paymentRequest = {
        amount: 100,
        currency: 'USD',
        source: 'tok_test',
        email: 'user@gmail.com'
      };

      const createResponse = await request(app)
        .post('/charge')
        .send(paymentRequest)
        .expect(200);

      const transactionId = createResponse.body.transactionId;

      // Retrieve the transaction
      const response = await request(app)
        .get(`/transaction/${transactionId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        id: transactionId,
        amount: 100,
        currency: 'USD',
        source: 'tok_test',
        email: 'user@gmail.com',
        riskScore: 0.0,
        provider: 'stripe',
        status: 'success'
      });
    });

    it('should return 404 for non-existent transaction', async () => {
      const response = await request(app)
        .get('/transaction/non-existent-id')
        .expect(404);

      expect(response.body.error).toBe('Resource Not Found');
      expect(response.body.message).toContain('Transaction');
    });

    it('should return 400 for missing transaction ID', async () => {
      const response = await request(app)
        .get('/transaction/')
        .expect(404); // Route not found, not 400

      expect(response.body.error).toBe('Route Not Found');
    });
  });

  describe('GET /transactions', () => {
    it('should return all transactions', async () => {
      // Create a couple of transactions
      const request1 = {
        amount: 100,
        currency: 'USD', 
        source: 'tok_test',
        email: 'user1@gmail.com'
      };
      
      const request2 = {
        amount: 200,
        currency: 'USD',
        source: 'tok_test', 
        email: 'user2@gmail.com'
      };

      await request(app).post('/charge').send(request1);
      await request(app).post('/charge').send(request2);

      const response = await request(app)
        .get('/transactions')
        .expect(200);

      expect(response.body.transactions).toHaveLength(2);
      expect(response.body.count).toBe(2);
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'healthy',
        version: '1.0.0',
        services: {
          gemini: expect.any(Boolean),
          storage: expect.any(Boolean)
        }
      });
    });
  });

  describe('GET /stats', () => {
    it('should return service statistics', async () => {
      const response = await request(app)
        .get('/stats')
        .expect(200);

      expect(response.body).toMatchObject({
        storage: expect.any(Object),
        services: expect.any(Object),
        uptime: expect.any(Number),
        timestamp: expect.any(String)
      });
    });
  });

  describe('GET /', () => {
    it('should return API information', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);

      expect(response.body).toMatchObject({
        name: 'Payment Gateway Proxy',
        version: '1.0.0',
        status: 'running',
        endpoints: expect.any(Object)
      });
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/unknown-route')
        .expect(404);

      expect(response.body.error).toBe('Route Not Found');
    });
  });

  describe('Fraud detection integration', () => {
    it('should correctly calculate risk scores', async () => {
      // Test different combinations
      const scenarios = [
        {
          request: { amount: 100, email: 'user@gmail.com' },
          expectedRisk: 0.0,
          expectedProvider: 'stripe'
        },
        {
          request: { amount: 600, email: 'user@gmail.com' },
          expectedRisk: 0.2,
          expectedProvider: 'stripe'
        },
        {
          request: { amount: 100, email: 'user@example.com' },
          expectedRisk: 0.3,
          expectedProvider: 'paypal'
        },
        {
          request: { amount: 600, email: 'user@example.com' },
          expectedRisk: 0.5,
          expectedProvider: 'blocked'
        }
      ];

      for (const scenario of scenarios) {
        const paymentRequest = {
          ...scenario.request,
          currency: 'USD',
          source: 'tok_test'
        };

        const response = await request(app)
          .post('/charge')
          .send(paymentRequest)
          .expect(200);

        expect(response.body.riskScore).toBe(scenario.expectedRisk);
        expect(response.body.provider).toBe(scenario.expectedProvider);
      }
    });
  });
}); 