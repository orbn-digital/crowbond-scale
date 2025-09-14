import * as Ably from 'ably';
import { BaseRealTimeProvider } from './RealTimeProvider';
import { ScaleStatus } from '../../types/scale.types';
import { createLogger } from '../../utils/logger';
import { config } from '../../config';

export class AblyProvider extends BaseRealTimeProvider {
  private readonly logger = createLogger('AblyProvider');
  // Use loose typing here to avoid dependency on Ably's internal type namespaces
  private service: Ably.Realtime;
  private channels: Map<string, any> = new Map();
  private presenceChannel?: any;

  constructor() {
    super('Ably');
    this.service = new Ably.Realtime({
      key: config.ably.apiKey,
      clientId: config.newRelic.appName,
      recover: (
        _lastConnectionDetails: unknown,
        callback: (shouldRecover: boolean) => void,
      ): void => {
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

  private getPresenceChannel(): any {
    if (!this.presenceChannel) {
      this.presenceChannel = this.service.channels.get('scales');
    }
    return this.presenceChannel;
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
      const { ip: _omitIp, ...rest } = status;
      await channel.publish('status-update', {
        ...rest,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({ err: error, scaleId }, 'Failed to publish status update');
      throw error;
    }
  }

  async enterPresence(status: ScaleStatus): Promise<void> {
    try {
      const channel = this.getPresenceChannel();
      // Enter presence as this service's clientId; include scale id in data
      await channel.presence.enter({
        id: status.id,
        isConnected: status.isConnected,
        lastSeen: status.lastSeen?.toISOString(),
        lastActivity: status.lastActivity?.toISOString(),
        errorCount: status.errorCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({ err: error, scaleId: status.id }, 'Failed to enter presence');
      throw error;
    }
  }

  async updatePresence(status: ScaleStatus): Promise<void> {
    try {
      const channel = this.getPresenceChannel();
      await channel.presence.update({
        id: status.id,
        isConnected: status.isConnected,
        lastSeen: status.lastSeen?.toISOString(),
        lastActivity: status.lastActivity?.toISOString(),
        errorCount: status.errorCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error({ err: error, scaleId: status.id }, 'Failed to update presence');
      // Do not rethrow to avoid disrupting periodic health checks
    }
  }

  async leavePresence(scaleId: string): Promise<void> {
    try {
      const channel = this.getPresenceChannel();
      await channel.presence.leave({ id: scaleId, timestamp: new Date().toISOString() });
    } catch (error) {
      this.logger.error({ err: error, scaleId }, 'Failed to leave presence');
      // Non-fatal
    }
  }

  close(): void {
    this.logger.info('Closing Ably connection');
    this.channels.forEach((channel) => {
      channel.detach();
    });
    if (this.presenceChannel) {
      try {
        this.presenceChannel.detach();
      } catch (e) {
        // ignore
      }
    }
    this.service.close();
  }
}
