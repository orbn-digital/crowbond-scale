import { EventEmitter } from 'events';
import { XtremScale } from '../scales/XtremScale';
import { RealTimeProvider, ScaleConfig, ScaleStatus, WeightData } from '../types/scale.types';
import { AblyProvider } from './realtime/AblyProvider';
import { createLogger } from '../utils/logger';
import { NewRelicMetrics } from '../utils/newrelic';
import { config } from '../config';

export class ScaleManager extends EventEmitter {
  private readonly logger = createLogger('ScaleManager');
  private readonly metrics = NewRelicMetrics.getInstance();
  private scales: Map<string, XtremScale> = new Map();
  private realTimeProvider: RealTimeProvider;
  private healthCheckInterval?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(realTimeProvider?: RealTimeProvider) {
    super();
    this.realTimeProvider = realTimeProvider || new AblyProvider();
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    const gracefulShutdown = async (signal: string): Promise<void> => {
      if (this.isShuttingDown) return;
      
      this.isShuttingDown = true;
      this.logger.info({ signal }, 'Received shutdown signal, closing connections...');
      this.metrics.recordShutdown(signal);
      
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    
    process.on('uncaughtException', (error) => {
      this.logger.fatal({ err: error }, 'Uncaught exception');
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.fatal({ reason, promise }, 'Unhandled rejection');
      process.exit(1);
    });
  }

  public async initialize(scaleConfigs: ScaleConfig[]): Promise<void> {
    this.logger.info({ scaleCount: scaleConfigs.length }, 'Initializing scale manager');

    for (const config of scaleConfigs) {
      await this.addScale(config);
    }

    this.startHealthCheck();
  }

  public async addScale(config: ScaleConfig): Promise<void> {
    let scaleId = config.id || config.ip;
    
    if (this.scales.has(scaleId)) {
      this.logger.warn({ scaleId }, 'Scale already exists');
      return;
    }

    try {
      const scale = new XtremScale(config);
      
      await scale.connect();
      
      // Try to get the actual scale ID (serial number)
      try {
        const actualId = await scale.getScaleId();
        if (actualId !== scaleId) {
          this.logger.info({ originalId: scaleId, actualId }, 'Using actual scale serial number');
          // Remove the temporary ID if it was already added
          if (this.scales.has(scaleId)) {
            this.scales.delete(scaleId);
          }
          scaleId = actualId; // Use the actual serial number as the ID
        }
      } catch (error) {
        this.logger.warn({ scaleId }, 'Could not retrieve scale ID, using default');
      }
      
      // Set up event handlers with the actual scale ID
      scale.on('weight', async (weightData: WeightData) => {
        await this.handleWeightUpdate(scaleId, weightData);
      });
      
      scale.on('error', (error) => {
        this.logger.error({ err: error, scaleId }, 'Scale error');
      });
      
      scale.on('connected', () => {
        this.logger.info({ scaleId }, 'Scale connected');
        this.metrics.recordScaleConnection(scaleId, true);
        this.emit('scaleConnected', scaleId);
      });
      
      scale.on('disconnected', () => {
        this.logger.warn({ scaleId }, 'Scale disconnected');
        this.metrics.recordScaleConnection(scaleId, false);
        this.emit('scaleDisconnected', scaleId);
      });

      this.scales.set(scaleId, scale);
      this.logger.info({ scaleId }, 'Scale added successfully');
    } catch (error) {
      this.logger.error({ err: error, scaleId }, 'Failed to add scale');
      throw error;
    }
  }

  public async removeScale(scaleId: string): Promise<void> {
    const scale = this.scales.get(scaleId);
    if (!scale) {
      this.logger.warn({ scaleId }, 'Scale not found');
      return;
    }

    try {
      await scale.close();
      this.scales.delete(scaleId);
      this.logger.info({ scaleId }, 'Scale removed');
    } catch (error) {
      this.logger.error({ err: error, scaleId }, 'Error removing scale');
      throw error;
    }
  }

  private lastWeightValues: Map<string, string> = new Map();

  private async handleWeightUpdate(scaleId: string, weightData: WeightData): Promise<void> {
    const lastWeight = this.lastWeightValues.get(scaleId);
    
    // Only publish if the weight has changed
    if (lastWeight !== weightData.display) {
      // Create a transaction for each weight update
      await this.metrics.startBackgroundTransaction(
        'WeightUpdate',
        'Scale',
        async () => {
          try {
            // Add transaction attributes
            this.metrics.addCustomAttributes({
              scaleId,
              weight: weightData.weight,
              unit: weightData.unit,
              display: weightData.display,
            });
            
            // Publish to Ably
            await this.metrics.startSegment('ably-publish', async () => {
              try {
                await this.realTimeProvider.updateWeight(scaleId, weightData.display);
                this.metrics.recordAblyPublish(scaleId, 'weight-update', true);
              } catch (error) {
                this.metrics.recordAblyPublish(scaleId, 'weight-update', false);
                throw error;
              }
            });
            
            this.lastWeightValues.set(scaleId, weightData.display);
            this.metrics.recordWeightMeasurement(scaleId, weightData);
            this.logger.debug({ scaleId, weight: weightData.display }, 'Weight changed, publishing update');
            this.emit('weightUpdate', scaleId, weightData);
          } catch (error) {
            this.logger.error({ err: error, scaleId }, 'Failed to handle weight update');
            throw error;
          }
        }
      );
    }
  }

  public async startStreaming(scaleId?: string): Promise<void> {
    if (scaleId) {
      const scale = this.scales.get(scaleId);
      if (!scale) {
        throw new Error(`Scale ${scaleId} not found`);
      }
      await scale.startStreaming();
    } else {
      // Start streaming for all scales
      const promises = Array.from(this.scales.entries()).map(async ([id, scale]) => {
        try {
          await scale.startStreaming();
          this.logger.info({ scaleId: id }, 'Streaming started');
        } catch (error) {
          this.logger.error({ err: error, scaleId: id }, 'Failed to start streaming');
        }
      });
      await Promise.allSettled(promises);
    }
  }

  public async stopStreaming(scaleId?: string): Promise<void> {
    if (scaleId) {
      const scale = this.scales.get(scaleId);
      if (!scale) {
        throw new Error(`Scale ${scaleId} not found`);
      }
      await scale.stopStreaming();
    } else {
      // Stop streaming for all scales
      const promises = Array.from(this.scales.entries()).map(async ([id, scale]) => {
        try {
          await scale.stopStreaming();
          this.logger.info({ scaleId: id }, 'Streaming stopped');
        } catch (error) {
          this.logger.error({ err: error, scaleId: id }, 'Failed to stop streaming');
        }
      });
      await Promise.allSettled(promises);
    }
  }

  public async getWeight(scaleId: string): Promise<WeightData> {
    const scale = this.scales.get(scaleId);
    if (!scale) {
      throw new Error(`Scale ${scaleId} not found`);
    }
    return scale.getWeight();
  }

  public getScaleStatus(scaleId: string): ScaleStatus | undefined {
    const scale = this.scales.get(scaleId);
    return scale?.getStatus();
  }

  public getAllScaleStatuses(): ScaleStatus[] {
    return Array.from(this.scales.values()).map((scale) => scale.getStatus());
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      // Create a transaction for health check
      await this.metrics.startBackgroundTransaction(
        'HealthCheck',
        'Monitoring',
        async () => {
          const statuses = this.getAllScaleStatuses();
          
          // Add transaction attributes
          this.metrics.addCustomAttributes({
            totalScales: statuses.length,
            connectedScales: statuses.filter(s => s.isConnected).length,
            totalErrors: statuses.reduce((sum, s) => sum + s.errorCount, 0),
          });
          
          // Record health check metrics
          this.metrics.recordHealthCheck(statuses);
          
          for (const status of statuses) {
            try {
              await this.realTimeProvider.updateStatus(status.id, status);
            } catch (error) {
              this.logger.error({ err: error, scaleId: status.id }, 'Failed to update status');
            }
          }
          
          this.emit('healthCheck', statuses);
        }
      );
    }, config.operational.healthCheckInterval);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down scale manager');
    
    this.stopHealthCheck();
    
    // Stop all streaming
    await this.stopStreaming();
    
    // Close all scale connections
    const promises = Array.from(this.scales.entries()).map(async ([id, scale]) => {
      try {
        await scale.close();
        this.logger.info({ scaleId: id }, 'Scale connection closed');
      } catch (error) {
        this.logger.error({ err: error, scaleId: id }, 'Error closing scale');
      }
    });
    
    await Promise.allSettled(promises);
    
    // Close real-time provider
    this.realTimeProvider.close();
    
    this.scales.clear();
    this.logger.info('Scale manager shutdown complete');
  }
}