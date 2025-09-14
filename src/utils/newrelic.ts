import newrelic from 'newrelic';
import { WeightData, ScaleStatus } from '../types/scale.types';
import { createLogger } from './logger';

const logger = createLogger('NewRelicMetrics');

// Check if New Relic is available and properly configured
const isNewRelicAvailable = (): boolean => {
  try {
    // Check if we can call basic New Relic functions
    return (
      typeof newrelic.recordMetric === 'function' && typeof newrelic.noticeError === 'function'
    );
  } catch {
    return false;
  }
};

export class NewRelicMetrics {
  private static instance: NewRelicMetrics;
  private isEnabled: boolean;

  private constructor() {
    this.isEnabled = isNewRelicAvailable();
    if (this.isEnabled) {
      logger.info('New Relic metrics initialized');
    } else {
      logger.warn('New Relic not available or not configured');
    }
  }

  public static getInstance(): NewRelicMetrics {
    if (!NewRelicMetrics.instance) {
      NewRelicMetrics.instance = new NewRelicMetrics();
    }
    return NewRelicMetrics.instance;
  }

  /**
   * Record a weight measurement event
   */
  public recordWeightMeasurement(scaleId: string, weightData: WeightData): void {
    if (!this.isEnabled) return;

    try {
      // Add custom attributes to current transaction
      newrelic.addCustomAttribute('scaleId', scaleId);
      newrelic.addCustomAttribute('weight', parseFloat(weightData.weight) || 0);
      newrelic.addCustomAttribute('unit', weightData.unit);
      newrelic.addCustomAttribute('display', weightData.display);

      // Record metric for weight value
      const weightValue = parseFloat(weightData.weight) || 0;
      newrelic.recordMetric('Custom/Scale/Weight', weightValue);
      newrelic.recordMetric(`Custom/Scale/${scaleId}/Weight`, weightValue);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record weight measurement');
    }
  }

  /**
   * Record scale connection event
   */
  public recordScaleConnection(scaleId: string, connected: boolean): void {
    if (!this.isEnabled) return;

    try {
      // Add custom attributes
      newrelic.addCustomAttribute('scaleId', scaleId);
      newrelic.addCustomAttribute('scaleConnected', connected);

      // Record metric for connection status (1 for connected, 0 for disconnected)
      newrelic.recordMetric(`Custom/Scale/${scaleId}/Connected`, connected ? 1 : 0);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record scale connection');
    }
  }

  /**
   * Record scale error
   */
  public recordScaleError(scaleId: string, error: Error): void {
    if (!this.isEnabled) return;

    try {
      newrelic.noticeError(error, {
        scaleId,
        errorType: 'ScaleError',
      });

      // Increment error counter metric
      newrelic.incrementMetric(`Custom/Scale/${scaleId}/Errors`);
    } catch (err) {
      logger.debug({ err }, 'Failed to record scale error');
    }
  }

  /**
   * Record UDP communication metrics
   */
  public recordUDPCommunication(
    scaleId: string,
    direction: 'sent' | 'received',
    bytes: number,
  ): void {
    if (!this.isEnabled) return;

    try {
      newrelic.recordMetric(`Custom/UDP/${direction}/Bytes`, bytes);
      newrelic.recordMetric(`Custom/UDP/${scaleId}/${direction}/Bytes`, bytes);
      newrelic.incrementMetric(`Custom/UDP/${scaleId}/${direction}/Count`);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record UDP communication');
    }
  }

  /**
   * Record health check
   */
  public recordHealthCheck(statuses: ScaleStatus[]): void {
    if (!this.isEnabled) return;

    try {
      const connected = statuses.filter((s) => s.isConnected).length;
      const total = statuses.length;
      const errorCount = statuses.reduce((sum, s) => sum + s.errorCount, 0);

      // Add custom attributes to current transaction
      newrelic.addCustomAttribute('healthCheckTotal', total);
      newrelic.addCustomAttribute('healthCheckConnected', connected);
      newrelic.addCustomAttribute('healthCheckErrors', errorCount);

      // Record gauge metrics
      newrelic.recordMetric('Custom/Scales/Total', total);
      newrelic.recordMetric('Custom/Scales/Connected', connected);
      newrelic.recordMetric('Custom/Scales/Disconnected', total - connected);
      newrelic.recordMetric('Custom/Scales/TotalErrors', errorCount);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record health check');
    }
  }

  /**
   * Start a custom transaction segment
   */
  public async startSegment<T>(name: string, handler: () => Promise<T>): Promise<T> {
    if (!this.isEnabled) return handler();

    try {
      // Use startSegment if available, otherwise just run the handler
      if (typeof newrelic.startSegment === 'function') {
        return await newrelic.startSegment(name, true, handler);
      } else {
        // Add custom attribute to mark this segment
        newrelic.addCustomAttribute('segment', name);
        return await handler();
      }
    } catch (error) {
      logger.debug({ err: error }, 'Failed to start segment');
      return handler();
    }
  }

  /**
   * Add custom attributes to current transaction
   */
  public addCustomAttributes(attributes: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    try {
      for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined) {
          continue;
        }
        const serializable =
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
            ? (value as string | number | boolean)
            : String(value);
        newrelic.addCustomAttribute(key, serializable);
      }
    } catch (error) {
      logger.debug({ err: error }, 'Failed to add custom attributes');
    }
  }

  /**
   * Create a background transaction for non-web operations
   */
  public async startBackgroundTransaction<T>(
    name: string,
    group: string,
    handler: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled) return handler();

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      await newrelic.startBackgroundTransaction(name, group, async () => {
        const transaction = newrelic.getTransaction();
        try {
          const result = await handler();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          transaction.end();
        }
      });
    });
  }

  /**
   * Record Ably publishing metrics
   */
  public recordAblyPublish(scaleId: string, eventType: string, success: boolean): void {
    if (!this.isEnabled) return;

    try {
      // Add custom attributes
      newrelic.addCustomAttribute('ablyScaleId', scaleId);
      newrelic.addCustomAttribute('ablyEventType', eventType);
      newrelic.addCustomAttribute('ablySuccess', success);

      if (success) {
        newrelic.incrementMetric(`Custom/Ably/${eventType}/Success`);
      } else {
        newrelic.incrementMetric(`Custom/Ably/${eventType}/Failed`);
      }
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record Ably publish');
    }
  }

  /**
   * Record startup metrics
   */
  public recordStartup(scaleCount: number): void {
    if (!this.isEnabled) return;

    try {
      newrelic.addCustomAttribute('startupScaleCount', scaleCount);
      newrelic.addCustomAttribute('nodeVersion', process.version);
      newrelic.addCustomAttribute('platform', process.platform);

      newrelic.recordMetric('Custom/Service/Startup', 1);
      newrelic.recordMetric('Custom/Service/ScaleCount', scaleCount);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record startup');
    }
  }

  /**
   * Record shutdown metrics
   */
  public recordShutdown(reason: string): void {
    if (!this.isEnabled) return;

    try {
      newrelic.addCustomAttribute('shutdownReason', reason);
      newrelic.addCustomAttribute('uptime', process.uptime());

      newrelic.recordMetric('Custom/Service/Shutdown', 1);
      newrelic.recordMetric('Custom/Service/Uptime', process.uptime());
    } catch (error) {
      logger.debug({ err: error }, 'Failed to record shutdown');
    }
  }
}
