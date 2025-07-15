import { Transaction, TransactionStatus } from '../models/types';
import logger from '../utils/logger';

/**
 * In-memory storage service for transactions
 * In production, this would be replaced with a proper database
 */
export class StorageService {
  private transactions = new Map<string, Transaction>();

  /**
   * Store a new transaction
   */
  async saveTransaction(transaction: Transaction): Promise<void> {
    try {
      this.transactions.set(transaction.id, { ...transaction });
      logger.info('Transaction saved', { 
        transactionId: transaction.id,
        amount: transaction.amount,
        provider: transaction.provider,
        riskScore: transaction.riskScore 
      });
    } catch (error) {
      logger.error('Failed to save transaction', { 
        transactionId: transaction.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new Error('Failed to save transaction');
    }
  }

  /**
   * Get a transaction by ID
   */
  async getTransaction(id: string): Promise<Transaction | null> {
    try {
      const transaction = this.transactions.get(id);
      if (transaction) {
        logger.debug('Transaction retrieved', { transactionId: id });
        return { ...transaction };
      }
      logger.debug('Transaction not found', { transactionId: id });
      return null;
    } catch (error) {
      logger.error('Failed to retrieve transaction', { 
        transactionId: id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Get all transactions
   */
  async getAllTransactions(): Promise<Transaction[]> {
    try {
      const transactions = Array.from(this.transactions.values())
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  
      logger.debug('Retrieved all transactions', { count: transactions.length });
      return transactions;
    } catch (error) {
      logger.error('Failed to retrieve all transactions', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Update transaction status
   */
  async updateTransactionStatus(
    id: string, 
    status: TransactionStatus,
    processedAt?: Date
  ): Promise<boolean> {
    try {
      const transaction = this.transactions.get(id);
      if (!transaction) {
        logger.warn('Cannot update non-existent transaction', { transactionId: id });
        return false;
      }

      const updatedTransaction = {
        ...transaction,
        status,
        processedAt: processedAt || new Date()
      };

      this.transactions.set(id, updatedTransaction);
      logger.info('Transaction status updated', { 
        transactionId: id,
        oldStatus: transaction.status,
        newStatus: status 
      });
      return true;
    } catch (error) {
      logger.error('Failed to update transaction status', { 
        transactionId: id,
        status,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }

  /**
   * Get all transactions for a specific email (for velocity checks)
   */
  async getTransactionsByEmail(
    email: string, 
    timeWindow?: number
  ): Promise<Transaction[]> {
    try {
      const cutoff = timeWindow 
        ? new Date(Date.now() - timeWindow * 60 * 1000) // timeWindow in minutes
        : null;

      const userTransactions = Array.from(this.transactions.values())
        .filter(t => t.email === email)
        .filter(t => cutoff ? t.timestamp >= cutoff : true)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      logger.debug('Retrieved transactions by email', { 
        email,
        count: userTransactions.length,
        timeWindow 
      });

      return userTransactions;
    } catch (error) {
      logger.error('Failed to retrieve transactions by email', { 
        email,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Get storage statistics
   */
  getStats(): { totalTransactions: number; memoryUsage: string } {
    const totalTransactions = this.transactions.size;
    const memoryUsage = `${(JSON.stringify(Array.from(this.transactions.values())).length / 1024).toFixed(2)} KB`;
    
    return {
      totalTransactions,
      memoryUsage
    };
  }

  /**
   * Clear all transactions (useful for testing)
   */
  async clear(): Promise<void> {
    this.transactions.clear();
    logger.info('All transactions cleared');
  }

  /**
   * Health check for storage service
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Test basic map operations
      const testId = 'health-check-test';
      const testTransaction: Transaction = {
        id: testId,
        amount: 1,
        currency: 'USD',
        source: 'test-source',
        email: 'test@health.check',
        riskScore: 0,
        explanation: 'Health check',
        provider: 'stripe',
        status: 'success',
        timestamp: new Date(),
        metadata: {
          riskFactors: []
        }
      };

      this.transactions.set(testId, testTransaction);
      const retrieved = this.transactions.get(testId);
      this.transactions.delete(testId);

      return retrieved?.id === testId;
    } catch (error) {
      logger.error('Storage health check failed', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }
}

// Export singleton instance
export const storageService = new StorageService(); 