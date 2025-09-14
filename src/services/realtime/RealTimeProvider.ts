import { RealTimeProvider, ScaleStatus } from '../../types/scale.types';

export abstract class BaseRealTimeProvider implements RealTimeProvider {
  protected readonly serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  abstract updateWeight(scaleId: string, weight: string): Promise<void>;
  abstract updateStatus(scaleId: string, status: ScaleStatus): Promise<void>;
  abstract enterPresence(status: ScaleStatus): Promise<void>;
  abstract updatePresence(status: ScaleStatus): Promise<void>;
  abstract leavePresence(scaleId: string): Promise<void>;
  abstract close(): void;
}
