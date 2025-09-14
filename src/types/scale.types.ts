export interface ScaleConfig {
  ip: string;
  localPort: number;
  remotePort: number;
  id?: string;
}

export interface WeightData {
  raw: string;
  address: string;
  command: string;
  weight: string;
  unit: string;
  timestamp: Date;
  display: string;
  scaleId?: string;
}

export interface ScaleStatus {
  id: string;
  ip: string;
  isConnected: boolean;
  lastSeen?: Date;
  lastWeight?: WeightData;
  lastActivity?: Date;
  errorCount: number;
  lastError?: string;
}

export interface ScaleIdentifier {
  serialNumber: string;
  fullRealm: string;
  identifier: string;
}

export enum ScaleCommand {
  START_STREAMING = '\u000200FFE10110000\u0003\r\n',
  STOP_STREAMING = '\u000200FFE10100000\u0003\r\n',
}

export interface RealTimeProvider {
  updateWeight(scaleId: string, weight: string): Promise<void>;
  updateStatus(scaleId: string, status: ScaleStatus): Promise<void>;
  // Presence for online discovery of scales
  enterPresence(status: ScaleStatus): Promise<void>;
  updatePresence(status: ScaleStatus): Promise<void>;
  leavePresence(scaleId: string): Promise<void>;
  close(): void;
}
