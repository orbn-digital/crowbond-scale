import * as dgram from 'dgram';
import * as http from 'http';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { NewRelicMetrics } from '../utils/newrelic';
import {
  ScaleConfig,
  WeightData,
  ScaleCommand,
  ScaleIdentifier,
  ScaleStatus,
} from '../types/scale.types';
import { config } from '../config';

export class XtremScale extends EventEmitter {
  private readonly logger = createLogger('XtremScale');
  private readonly metrics = NewRelicMetrics.getInstance();
  private client: dgram.Socket | null = null;
  private scaleIP: string;
  private localPort: number;
  private remotePort: number;
  private id: string;
  private isConnected = false;
  private rxBuffer = '';
  private streamingMode = false;
  private weightData: WeightData | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private errorCount = 0;
  private lastError?: string;

  constructor(config: ScaleConfig) {
    super();
    this.scaleIP = config.ip;
    this.localPort = config.localPort;
    this.remotePort = config.remotePort;
    this.id = config.id || config.ip;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.client = dgram.createSocket('udp4');

        this.client.on('message', (msg, rinfo) => {
          if (!this.streamingMode) {
            this.logger.debug(`Received from ${rinfo.address}:${rinfo.port}`);
          }
          this.metrics.recordUDPCommunication(this.id, 'received', msg.length);
          this.handleMessage(msg.toString());
        });

        this.client.on('error', (err) => {
          this.logger.error({ err, scaleId: this.id }, 'UDP error');
          this.isConnected = false;
          this.errorCount++;
          this.lastError = err.message;
          this.metrics.recordScaleError(this.id, err);
          this.emit('error', err);
          this.scheduleReconnect();
        });

        this.client.on('close', () => {
          this.logger.info({ scaleId: this.id }, 'Connection closed');
          this.isConnected = false;
          this.emit('disconnected');
        });

        this.client.bind(this.localPort, () => {
          this.logger.info(
            {
              scaleId: this.id,
              localPort: this.localPort,
              remoteEndpoint: `${this.scaleIP}:${this.remotePort}`,
            },
            'Scale connection established',
          );
          this.isConnected = true;
          this.errorCount = 0;
          this.emit('connected');
          resolve();
        });
      } catch (error) {
        this.logger.error({ err: error, scaleId: this.id }, 'Failed to connect');
        reject(error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(config.operational.retryDelay * Math.pow(2, this.errorCount), 30000);
    this.logger.info(
      { scaleId: this.id, delay, errorCount: this.errorCount },
      'Scheduling reconnection',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect().catch((err) => {
        this.logger.error({ err, scaleId: this.id }, 'Reconnection failed');
      });
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = null;
    }
    await this.connect();
  }

  public async sendCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.isConnected) {
        const error = new Error('Scale not connected');
        this.logger.error({ scaleId: this.id }, error.message);
        reject(error);
        return;
      }

      const buffer = Buffer.from(command);
      this.client.send(buffer, this.remotePort, this.scaleIP, (err) => {
        if (err) {
          this.logger.error({ err, scaleId: this.id }, 'Send error');
          this.metrics.recordScaleError(this.id, err);
          reject(err);
        } else {
          this.metrics.recordUDPCommunication(this.id, 'sent', buffer.length);
          if (!this.streamingMode) {
            this.logger.debug(
              { scaleId: this.id, command: this.formatCommand(command) },
              'Command sent',
            );
          }
          resolve();
        }
      });
    });
  }

  private formatCommand(command: string): string {
    return command.replace(/[\u0002\u0003\r\n]/g, (match) => {
      const replacements: Record<string, string> = {
        '\u0002': '[STX]',
        '\u0003': '[ETX]',
        '\r': '[CR]',
        '\n': '[LF]',
      };
      return replacements[match] || match;
    });
  }

  public async startStreaming(): Promise<void> {
    this.streamingMode = true;
    await this.sendCommand(ScaleCommand.START_STREAMING);
    this.logger.info({ scaleId: this.id }, 'Streaming started');
  }

  public async stopStreaming(): Promise<void> {
    this.streamingMode = false;
    await this.sendCommand(ScaleCommand.STOP_STREAMING);
    this.logger.info({ scaleId: this.id }, 'Streaming stopped');
  }

  private handleMessage(message: string): void {
    if (!this.streamingMode) {
      this.logger.debug(
        {
          scaleId: this.id,
          messageLength: message.length,
          hex: Buffer.from(message).toString('hex'),
        },
        'Received data',
      );
    }

    this.rxBuffer += message;

    // Look for complete messages between STX and ETX
    while (this.rxBuffer.includes('\u0002') && this.rxBuffer.includes('\u0003')) {
      const stxIndex = this.rxBuffer.indexOf('\u0002');
      const etxIndex = this.rxBuffer.indexOf('\u0003', stxIndex);

      if (etxIndex > stxIndex) {
        const completeMessage = this.rxBuffer.substring(stxIndex + 1, etxIndex);
        this.parseWeightData(completeMessage);
        this.rxBuffer = this.rxBuffer.substring(etxIndex + 1);
      } else {
        break;
      }
    }

    // Alternative parsing for messages without STX/ETX
    if (!this.rxBuffer.includes('\u0002') && this.rxBuffer.length > 4) {
      const strippedMessage = this.rxBuffer.substring(1, this.rxBuffer.length - 3);
      if (strippedMessage.length >= 15) {
        this.logger.debug({ scaleId: this.id }, 'Using alternative parsing');
        this.parseWeightData(strippedMessage);
        this.rxBuffer = '';
      }
    }
  }

  private parseWeightData(data: string): void {
    if (!this.streamingMode) {
      this.logger.debug({ scaleId: this.id, rawData: data }, 'Parsing weight data');
    }

    if (data.length >= 15) {
      const address = data.substring(0, 2);
      const command = data.substring(2, 4);

      if (data.substring(4, 5) === 'r') {
        // Weight data format
        const weightString = data.substring(13, 24).trim();
        const unit = data.substring(24, 26).trim();

        this.weightData = {
          raw: data,
          address,
          command,
          weight: weightString,
          unit,
          timestamp: new Date(),
          display: `${weightString} ${unit}`,
          scaleId: this.id,
        };

        this.emit('weight', this.weightData);

        if (!this.streamingMode) {
          this.logger.info(
            { scaleId: this.id, weight: this.weightData.display },
            'Weight received',
          );
        }
      } else if (data.substring(4, 5) === 'e') {
        // Status message
        if (!this.streamingMode) {
          this.logger.debug({ scaleId: this.id, statusMessage: data }, 'Status message');
        }
        this.emit('status', data);
      } else {
        // Other data format
        this.weightData = {
          raw: data,
          address,
          command,
          weight: data.substring(4),
          unit: '',
          timestamp: new Date(),
          display: data.substring(4),
          scaleId: this.id,
        };
        this.emit('weight', this.weightData);
      }
    }
  }

  public async getWeight(timeout = config.scales.timeout): Promise<WeightData> {
    this.weightData = null;
    await this.startStreaming();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(async () => {
        await this.stopStreaming();
        if (!this.weightData) {
          reject(new Error('Timeout waiting for weight data'));
        }
      }, timeout);

      const checkInterval = setInterval(async () => {
        if (this.weightData) {
          clearTimeout(timeoutId);
          clearInterval(checkInterval);
          await this.stopStreaming();
          resolve(this.weightData);
        }
      }, 100);
    });
  }

  public async streamContinuous(callback: (weight: WeightData) => Promise<void>): Promise<void> {
    this.streamingMode = true;
    await this.startStreaming();

    this.on('weight', async (weightData: WeightData) => {
      try {
        await callback(weightData);
      } catch (error) {
        this.logger.error({ err: error, scaleId: this.id }, 'Error in weight callback');
      }
    });

    // Keep the process alive
    return new Promise(() => {});
  }

  public async getScaleIdentifier(): Promise<ScaleIdentifier> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: this.scaleIP,
        port: 80,
        path: '/',
        method: 'GET',
        timeout: 3000,
      };

      const req = http.request(options, (res) => {
        if (res.statusCode === 401) {
          const authHeader = res.headers['www-authenticate'];
          if (authHeader) {
            const realmMatch = authHeader.match(/realm="([^"]+)"/);
            if (realmMatch && realmMatch[1]) {
              const realm = realmMatch[1];
              const serialNumber = realm.replace('XTREM', '');

              resolve({
                serialNumber,
                fullRealm: realm,
                identifier: serialNumber,
              });
              return;
            }
          }
        }

        res.on('data', () => {});
        res.on('end', () => {
          if (!res.headers['www-authenticate']) {
            reject(new Error('No authentication realm found'));
          }
        });
      });

      req.on('error', (err) => {
        this.logger.error({ err, scaleId: this.id }, 'Failed to get scale identifier');
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout getting scale identifier'));
      });

      req.end();
    });
  }

  public async getScaleId(): Promise<string> {
    try {
      const info = await this.getScaleIdentifier();
      // Update the internal ID to use the actual scale serial number
      this.id = info.serialNumber;
      return info.serialNumber;
    } catch (error) {
      this.logger.warn({ scaleId: this.id }, 'Failed to get scale ID, using IP as fallback');
      return this.scaleIP;
    }
  }

  public getStatus(): ScaleStatus {
    return {
      id: this.id,
      ip: this.scaleIP,
      isConnected: this.isConnected,
      lastSeen: this.weightData?.timestamp,
      lastWeight: this.weightData || undefined,
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }

  public async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.isConnected && this.streamingMode) {
      try {
        await this.stopStreaming();
      } catch (error) {
        this.logger.error({ err: error, scaleId: this.id }, 'Error stopping streaming');
      }
    }

    return new Promise((resolve) => {
      if (this.client) {
        this.client.close(() => {
          this.logger.info({ scaleId: this.id }, 'Connection closed');
          this.isConnected = false;
          this.client = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
