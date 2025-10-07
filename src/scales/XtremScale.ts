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
  private heartbeatTimer?: NodeJS.Timeout;
  private lastHeartbeat?: Date;
  private errorCount = 0;
  private lastError?: string;
  private handlingError = false;

  constructor(config: ScaleConfig) {
    super();
    this.scaleIP = config.ip;
    this.localPort = config.localPort;
    this.remotePort = config.remotePort;
    this.id = config.id || config.ip;
  }

  private async chooseAvailablePort(): Promise<number> {
    // Try to reserve the configured port; if taken, fall back to ephemeral (0)
    const desired = this.localPort;
    const tmp = dgram.createSocket('udp4');
    return await new Promise<number>((resolve) => {
      const cleanup = (): void => {
        try {
          tmp.removeAllListeners();
          tmp.close();
        } catch {
          // noop
        }
      };
      tmp.once('error', (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err && err.code === 'EADDRINUSE') {
          this.logger.warn(
            { scaleId: this.id, port: desired },
            'Local UDP port in use, using ephemeral port',
          );
          resolve(0);
        } else {
          // Unknown error: still fall back to ephemeral to avoid startup failure
          this.logger.warn(
            { err, scaleId: this.id, port: desired },
            'Port check failed, using ephemeral port',
          );
          resolve(0);
        }
      });
      tmp.once('listening', () => {
        cleanup();
        resolve(desired);
      });
      try {
        tmp.bind(desired);
      } catch {
        cleanup();
        resolve(0);
      }
    });
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let connectionValidated = false;
        let connectionTimeout: NodeJS.Timeout;

        this.client.on('message', (msg, rinfo) => {
          // Only accept datagrams from the configured scale endpoint
          if (rinfo.address !== this.scaleIP || rinfo.port !== this.remotePort) {
            this.logger.debug(
              { scaleId: this.id, from: `${rinfo.address}:${rinfo.port}` },
              'Ignoring datagram from unexpected endpoint',
            );
            return;
          }
          if (!this.streamingMode) {
            this.logger.debug(`Received from ${rinfo.address}:${rinfo.port}`);
          }

          // First message validates the connection
          if (!connectionValidated) {
            connectionValidated = true;
            clearTimeout(connectionTimeout);
            this.logger.info(
              {
                scaleId: this.id,
                localPort: this.localPort,
                remoteEndpoint: `${this.scaleIP}:${this.remotePort}`,
              },
              'Scale connection verified - received first response',
            );
            this.isConnected = true;
            this.errorCount = 0;
            this.emit('connected');
            this.startHeartbeat();
            resolve();
            // Do not parse the first message (handshake response)
            return;
          }

          this.lastHeartbeat = new Date();
          this.metrics.recordUDPCommunication(this.id, 'received', msg.length);
          this.handleMessage(msg.toString());
        });

        this.client.on('error', (err) => {
          if (this.handlingError) {
            return;
          }
          this.handlingError = true;
          this.logger.error({ err, scaleId: this.id }, 'UDP error');
          this.isConnected = false;
          this.errorCount++;
          this.lastError = err.message;
          this.lastHeartbeat = undefined;
          this.stopHeartbeat();
          this.metrics.recordScaleError(this.id, err);
          // Emit both error and disconnected so upstream can react immediately
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
          this.emit('disconnected');
          if (!connectionValidated) {
            clearTimeout(connectionTimeout);
            // Attempt reconnects even if initial validation failed
            this.scheduleReconnect();
            reject(err);
          } else {
            this.scheduleReconnect();
          }
          // Reset handling flag in next tick to allow subsequent errors
          setImmediate(() => {
            this.handlingError = false;
          });
        });

        this.client.on('close', () => {
          this.logger.info({ scaleId: this.id }, 'Connection closed');
          this.isConnected = false;
          this.emit('disconnected');
        });

        this.client.on('listening', () => {
          try {
            const addr = this.client?.address();
            if (addr && typeof addr === 'object') {
              if (this.localPort !== addr.port) {
                this.logger.info(
                  { scaleId: this.id, oldPort: this.localPort, newPort: addr.port },
                  'Using fallback local UDP port',
                );
                this.localPort = addr.port;
              }
            }
          } catch {
            // noop
          }
        });

        // Decide final port to bind (desired or ephemeral)
        void this.chooseAvailablePort()
          .then((portToBind) => {
            this.client?.bind({ port: portToBind, exclusive: false }, async () => {
              this.logger.info(
                {
                  scaleId: this.id,
                  localPort: this.localPort,
                  remoteEndpoint: `${this.scaleIP}:${this.remotePort}`,
                },
                'UDP socket bound, attempting to verify scale connection',
              );

              // Do not use UDP connect(); we filter by rinfo in 'message'

              // Set a timeout for connection validation
              const validationTimeout = config.operational.verificationTimeout || 2000; // 2 seconds default
              connectionTimeout = setTimeout(() => {
                if (!connectionValidated) {
                  const error = new Error(`Scale at ${this.scaleIP} is not responding`);
                  this.logger.error(
                    {
                      scaleId: this.id,
                      ip: this.scaleIP,
                      timeout: validationTimeout,
                    },
                    'Scale connection validation timeout - scale may be offline',
                  );
                  this.isConnected = false;
                  if (this.client) {
                    this.client.removeAllListeners();
                    this.client.close();
                    this.client = null;
                  }
                  // Schedule reconnect attempts after validation timeout
                  this.scheduleReconnect();
                  reject(error);
                }
              }, validationTimeout);

              // Send initial command to trigger response from scale (skip in test env)
              try {
                if (config.env !== 'test') {
                  await this.sendCommand(ScaleCommand.STOP_STREAMING, true);
                  this.logger.debug({ scaleId: this.id }, 'Sent initial handshake command');
                }
              } catch (err: unknown) {
                clearTimeout(connectionTimeout);

                const code =
                  err && typeof err === 'object' && 'code' in err
                    ? String((err as { code?: unknown }).code)
                    : undefined;

                if (code === 'EHOSTDOWN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
                  const error = new Error(
                    `Cannot reach scale at ${this.scaleIP}:${this.remotePort} - scale may be offline or on different network`,
                  );
                  this.logger.error(
                    {
                      scaleId: this.id,
                      ip: this.scaleIP,
                      port: this.remotePort,
                      errorCode: code,
                    },
                    'Network error - scale unreachable',
                  );
                  this.isConnected = false;
                  if (this.client) {
                    this.client.removeAllListeners();
                    this.client.close();
                    this.client = null;
                  }
                  // Proactively schedule reconnect after initial network error
                  this.scheduleReconnect();
                  reject(error);
                } else {
                  this.logger.error({ err, scaleId: this.id }, 'Failed to send handshake');
                  reject(err as Error);
                }
              }
            });
          })
          .catch((err) => {
            this.logger.error({ err, scaleId: this.id }, 'Failed to choose/bind local UDP port');
            reject(err);
          });
      } catch (error) {
        this.logger.error({ err: error, scaleId: this.id }, 'Failed to connect');
        reject(error);
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    const heartbeatInterval = config.operational.heartbeatInterval || 30000;
    const inactivityTimeout = config.operational.inactivityTimeout || 60000;

    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) {
        return;
      }

      const now = new Date();
      const lastActivity = this.lastHeartbeat;

      // Only check for inactivity if we've received at least one message
      if (!lastActivity) {
        this.logger.debug(
          {
            scaleId: this.id,
          },
          'Waiting for initial communication from scale',
        );
        return;
      }

      const timeSinceLastActivity = now.getTime() - lastActivity.getTime();

      if (timeSinceLastActivity > inactivityTimeout) {
        this.logger.warn(
          {
            scaleId: this.id,
            lastActivity: lastActivity.toISOString(),
            timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000) + 's',
          },
          'Scale inactive, marking as disconnected',
        );

        this.handleInactivity();
      } else if (this.streamingMode && timeSinceLastActivity > heartbeatInterval) {
        this.logger.debug(
          {
            scaleId: this.id,
            timeSinceLastActivity: Math.round(timeSinceLastActivity / 1000) + 's',
          },
          'No recent activity from scale',
        );
      }
    }, heartbeatInterval);

    // Don't set lastHeartbeat here - wait for actual communication
    // this.lastHeartbeat = new Date();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private handleInactivity(): void {
    this.logger.error({ scaleId: this.id }, 'Scale inactive, marking as disconnected');
    this.isConnected = false;
    this.streamingMode = false;
    this.stopHeartbeat();
    this.emit('disconnected');
    this.metrics.recordScaleError(this.id, new Error('Scale inactive'));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Faster reconnection: start at 1 second, then back off to max 5s
    const backoff = Math.pow(1.5, Math.max(this.errorCount - 1, 0));
    const delay = Math.min(1000 * backoff, 5000);
    this.logger.info(
      { scaleId: this.id, delay, errorCount: this.errorCount },
      'Scheduling reconnection',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect().catch((err) => {
        this.logger.error({ err, scaleId: this.id }, 'Reconnection failed, will retry');
        this.errorCount++;
        // Schedule another reconnection attempt
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async reconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = null;
    }
    await this.connect();
  }

  public async sendCommand(command: string, skipConnectionCheck = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!skipConnectionCheck && !this.isConnected) {
        const error = new Error('Scale not connected');
        this.logger.error({ scaleId: this.id }, error.message);
        reject(error);
        return;
      }

      if (!this.client) {
        const error = new Error('UDP client not initialized');
        this.logger.error({ scaleId: this.id }, error.message);
        reject(error);
        return;
      }

      const buffer = Buffer.from(command);
      const onSend = (err: Error | null, bytes?: number): void => {
        if (err) {
          this.logger.error({ err, scaleId: this.id }, 'Send error');
          this.metrics.recordScaleError(this.id, err);
          reject(err);
        } else {
          this.metrics.recordUDPCommunication(this.id, 'sent', bytes ?? buffer.length);
          if (!this.streamingMode) {
            this.logger.debug(
              { scaleId: this.id, command: this.formatCommand(command) },
              'Command sent',
            );
          }
          resolve();
        }
      };

      try {
        // Always send with explicit destination; avoid connected UDP edge cases
        this.client.send(buffer, 0, buffer.length, this.remotePort, this.scaleIP, onSend);
      } catch (err) {
        this.logger.error({ err, scaleId: this.id }, 'Send threw');
        reject(err as Error);
      }
    });
  }

  private formatCommand(command: string): string {
    // eslint-disable-next-line no-control-regex
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
        this.logger.debug(completeMessage);
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

    if (data.length < 4) {
      return;
    }

    const address = data.substring(0, 2);
    const command = data.substring(2, 4);
    const typeChar = data.length >= 5 ? data.substring(4, 5) : '';

    if (typeChar === 'r') {
      // Weight data format – prefer explicit W segment (e.g., "W   0.000kg")
      // Example full frame: 0100r01071AW   0.000kgT   0.000kgS01561
      //                       ^^^^ ^      ^ weight          ^ tare
      //                       addr cmd    type 'r'

      // 1) Try to parse the W segment specifically so we ignore trailing fields (T/S)
      let weightString = '';
      let unit = '';

      const wMatch = data.match(/W\s*([+-]?\d+(?:\.\d+)?)(?:\s*)([a-zA-Z]+)/);
      if (wMatch) {
        weightString = wMatch[1];
        unit = wMatch[2];
      } else {
        // 2) Fallback: look for the first number+unit pair after the type char
        // This covers simpler frames like "...r... 100.5 kg"
        const afterType = data.substring(5);
        const genericMatch = afterType.match(/([+-]?\d+(?:\.\d+)?)(?:\s*)([a-zA-Z]+)/);
        if (genericMatch) {
          weightString = genericMatch[1];
          unit = genericMatch[2];
        }
      }

      this.weightData = {
        raw: data,
        address,
        command,
        weight: weightString,
        unit,
        timestamp: new Date(),
        display: unit ? `${weightString} ${unit}` : weightString,
        scaleId: this.id,
      };

      this.emit('weight', this.weightData);

      if (!this.streamingMode) {
        this.logger.info({ scaleId: this.id, weight: this.weightData.display }, 'Weight received');
      }
    } else if (typeChar === 'e') {
      // Status message
      if (!this.streamingMode) {
        this.logger.debug({ scaleId: this.id, statusMessage: data }, 'Status message');
      }
      this.emit('status', data);
    } else {
      // Other/unknown data
      const value = data.length > 4 ? data.substring(4) : data;
      this.weightData = {
        raw: data,
        address,
        command,
        weight: value,
        unit: '',
        timestamp: new Date(),
        display: value,
        scaleId: this.id,
      };
      this.emit('weight', this.weightData);
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
    } catch {
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
      lastActivity: this.lastHeartbeat,
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }

  public async close(): Promise<void> {
    this.stopHeartbeat();

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
