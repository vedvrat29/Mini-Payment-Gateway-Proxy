import { StorageService } from '../../src/services/storage.service';
import { Transaction } from '../../src/models/types';

describe('StorageService', () => {
  let storageService: StorageService;

  beforeEach(async () => {
    storageService = new StorageService();
    await storageService.clear();
  });

  afterEach(async () => {
    await storageService.clear();
  });

  const createSampleTransaction = (): Transaction => ({
    id: 'test-transaction-123',
    amount: 100,
    currency: 'USD',
    source: 'card_1234567890',
    email: 'test@example.com',
    riskScore: 0.2,
    explanation: 'Low risk transaction',
    provider: 'stripe',
    status: 'success',
    timestamp: new Date(),
    metadata: {
      riskFactors: []
    }
  });

  describe('saveTransaction', () => {
    it('should save a transaction successfully', async () => {
      const transaction = createSampleTransaction();

      await expect(storageService.saveTransaction(transaction)).resolves.toBeUndefined();
      
      const retrieved = await storageService.getTransaction(transaction.id);
      expect(retrieved).toEqual(transaction);
    });

    it('should handle saving multiple transactions', async () => {
      const transactions = [
        { ...createSampleTransaction(), id: 'tx-1' },
        { ...createSampleTransaction(), id: 'tx-2' },
        { ...createSampleTransaction(), id: 'tx-3' }
      ];

      for (const tx of transactions) {
        await storageService.saveTransaction(tx);
      }

      for (const tx of transactions) {
        const retrieved = await storageService.getTransaction(tx.id);
        expect(retrieved?.id).toBe(tx.id);
      }
    });
  });

  describe('getTransaction', () => {
    it('should retrieve an existing transaction', async () => {
      const transaction = createSampleTransaction();
      await storageService.saveTransaction(transaction);

      const retrieved = await storageService.getTransaction(transaction.id);
      
      expect(retrieved).toEqual(transaction);
    });

    it('should return null for non-existent transaction', async () => {
      const retrieved = await storageService.getTransaction('non-existent-id');
      
      expect(retrieved).toBeNull();
    });
  });

  describe('updateTransactionStatus', () => {
    it('should update transaction status successfully', async () => {
      const transaction = createSampleTransaction();
      await storageService.saveTransaction(transaction);

      const processedAt = new Date();
      const updated = await storageService.updateTransactionStatus(
        transaction.id, 
        'success',
        processedAt
      );

      expect(updated).toBe(true);

      const retrieved = await storageService.getTransaction(transaction.id);
      expect(retrieved?.status).toBe('success');
      expect(retrieved?.processedAt).toEqual(processedAt);
    });

    it('should return false for non-existent transaction', async () => {
      const updated = await storageService.updateTransactionStatus(
        'non-existent-id',
        'success'
      );

      expect(updated).toBe(false);
    });
  });

  describe('getTransactionsByEmail', () => {
    it('should retrieve transactions by email', async () => {
      const email = 'user@example.com';
      const transactions = [
        { ...createSampleTransaction(), id: 'tx-1', email },
        { ...createSampleTransaction(), id: 'tx-2', email },
        { ...createSampleTransaction(), id: 'tx-3', email: 'other@example.com' }
      ];

      for (const tx of transactions) {
        await storageService.saveTransaction(tx);
      }

      const userTransactions = await storageService.getTransactionsByEmail(email);

      expect(userTransactions).toHaveLength(2);
      expect(userTransactions.every(tx => tx.email === email)).toBe(true);
    });

    it('should filter by time window', async () => {
      const email = 'user@example.com';
      const now = new Date();
      const oldTransaction = {
        ...createSampleTransaction(),
        id: 'old-tx',
        email,
        timestamp: new Date(now.getTime() - 60 * 60 * 1000) // 1 hour ago
      };
      const recentTransaction = {
        ...createSampleTransaction(),
        id: 'recent-tx',
        email,
        timestamp: now
      };

      await storageService.saveTransaction(oldTransaction);
      await storageService.saveTransaction(recentTransaction);

      // Get transactions from last 30 minutes
      const recentTransactions = await storageService.getTransactionsByEmail(email, 30);

      expect(recentTransactions).toHaveLength(1);
      expect(recentTransactions[0]?.id).toBe('recent-tx');
    });

    it('should return empty array for unknown email', async () => {
      const transactions = await storageService.getTransactionsByEmail('unknown@example.com');
      expect(transactions).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      // Add some transactions
      const transactions = [
        { ...createSampleTransaction(), id: 'tx-1' },
        { ...createSampleTransaction(), id: 'tx-2' }
      ];

      for (const tx of transactions) {
        await storageService.saveTransaction(tx);
      }

      const stats = storageService.getStats();

      expect(stats.totalTransactions).toBe(2);
      expect(stats.memoryUsage).toMatch(/^\d+(\.\d+)? KB$/);
    });
  });

  describe('clear', () => {
    it('should clear all transactions', async () => {
      const transaction = createSampleTransaction();
      await storageService.saveTransaction(transaction);

      await storageService.clear();

      const retrieved = await storageService.getTransaction(transaction.id);
      expect(retrieved).toBeNull();

      const stats = storageService.getStats();
      expect(stats.totalTransactions).toBe(0);
    });
  });

  describe('healthCheck', () => {
    it('should return true for healthy service', async () => {
      const isHealthy = await storageService.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });
}); 