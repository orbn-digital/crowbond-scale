import * as Ably from 'ably';
import { BaseRealTimeProvider } from './RealTimeProvider';
import { ScaleStatus } from '../../types/scale.types';
import { createLogger } from '../../utils/logger';
import { config } from '../../config';

export class AblyProvider extends BaseRealTimeProvider {
  private readonly logger = createLogger('AblyProvider');
  private service: Ably.Realtime;
  private channels: Map<string, any> = new Map();

  constructor() {
    super('Ably');
    this.service = new Ably.Realtime({
      key: config.ably.apiKey,
      clientId: config.newRelic.appName,
      recover: (_lastConnectionDetails: any, callback: any) => {
        // Attempt to recover connection
        callback(true);
      },
    });

    this.service.connection.on('connected', () => {
      this.logger.info('Connected to Ably');
    });

    this.service.connection.on('disconnected', () => {
      this.logger.warn('Disconnected from Ably');
    });

    this.service.connection.on('failed', (error) => {
      this.logger.error({ err: error }, 'Ably connection failed');
    });
  }

  private getChannel(scaleId: string): any {
    if (!this.channels.has(scaleId)) {
      const channel = this.service.channels.get(`scale-${scaleId}`);
      this.channels.set(scaleId, channel);
    }
    return this.channels.get(scaleId)!;
  }

  async updateWeight(scaleId: string, weight: string): Promise<void> {
    try {
      const channel = this.getChannel(scaleId);
      await channel.publish('weight-update', {
        scaleId,
        weight,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({ err: error, scaleId }, 'Failed to publish weight update');
      throw error;
    }
  }

  async updateStatus(scaleId: string, status: ScaleStatus): Promise<void> {
    try {
      const channel = this.getChannel(scaleId);
      await channel.publish('status-update', {
        ...status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({ err: error, scaleId }, 'Failed to publish status update');
      throw error;
    }
  }

  close(): void {
    this.logger.info('Closing Ably connection');
    this.channels.forEach((channel) => {
      channel.detach();
    });
    this.service.close();
  }
}