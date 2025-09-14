import * as Ably from 'ably';
import { AblyProvider } from '../../src/services/realtime/AblyProvider';
import { ScaleStatus } from '../../src/types/scale.types';
import { config } from '../../src/config';

// Mock Ably
jest.mock('ably');

describe('AblyProvider', () => {
  let provider: AblyProvider;
  let mockRealtime: jest.Mocked<Ably.Realtime>;
  let mockChannel: any;
  let mockConnection: any;

  beforeEach(() => {
    // Create mock channel
    mockChannel = {
      publish: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn(),
    } as any;

    // Create mock connection
    mockConnection = {
      on: jest.fn(),
      state: 'connected',
    };

    // Create mock Realtime instance
    mockRealtime = {
      connection: mockConnection,
      channels: {
        get: jest.fn().mockReturnValue(mockChannel),
      },
      close: jest.fn(),
    } as any;

    // Mock Ably.Realtime constructor
    (Ably.Realtime as jest.MockedClass<typeof Ably.Realtime>).mockImplementation(
      () => mockRealtime,
    );

    provider = new AblyProvider();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize Ably connection with correct config', () => {
      expect(Ably.Realtime).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.any(String),
          clientId: config.newRelic.appName,
          recover: expect.any(Function),
        }),
      );
    });

    it('should set up connection event handlers', () => {
      expect(mockConnection.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockConnection.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockConnection.on).toHaveBeenCalledWith('failed', expect.any(Function));
    });
  });

  describe('updateWeight', () => {
    it('should publish weight update to correct channel', async () => {
      const scaleId = 'scale-1';
      const weight = '10.5 kg';

      await provider.updateWeight(scaleId, weight);

      expect(mockRealtime.channels.get).toHaveBeenCalledWith(`scale-${scaleId}`);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'weight-update',
        expect.objectContaining({
          scaleId,
          weight,
          timestamp: expect.any(String),
        }),
      );
    });

    it('should reuse existing channel for same scaleId', async () => {
      const scaleId = 'scale-1';

      await provider.updateWeight(scaleId, '10.5 kg');
      await provider.updateWeight(scaleId, '11.0 kg');

      // Should only create channel once
      expect(mockRealtime.channels.get).toHaveBeenCalledTimes(1);
      expect(mockChannel.publish).toHaveBeenCalledTimes(2);
    });

    it('should handle publish errors', async () => {
      const error = new Error('Publish failed');
      mockChannel.publish.mockRejectedValue(error);

      await expect(provider.updateWeight('scale-1', '10.5 kg')).rejects.toThrow('Publish failed');
    });
  });

  describe('updateStatus', () => {
    it('should publish status update to correct channel', async () => {
      const scaleId = 'scale-1';
      const status: ScaleStatus = {
        id: scaleId,
        ip: '192.168.1.100',
        isConnected: true,
        lastSeen: new Date(),
        errorCount: 0,
      };

      await provider.updateStatus(scaleId, status);

      expect(mockRealtime.channels.get).toHaveBeenCalledWith(`scale-${scaleId}`);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'status-update',
        expect.objectContaining({
          ...status,
          timestamp: expect.any(String),
        }),
      );
    });

    it('should handle status update errors', async () => {
      const error = new Error('Status update failed');
      mockChannel.publish.mockRejectedValue(error);

      const status: ScaleStatus = {
        id: 'scale-1',
        ip: '192.168.1.100',
        isConnected: false,
        errorCount: 1,
        lastError: 'Connection lost',
      };

      await expect(provider.updateStatus('scale-1', status)).rejects.toThrow(
        'Status update failed',
      );
    });
  });

  describe('close', () => {
    it('should detach all channels and close connection', async () => {
      // Create multiple channels
      await provider.updateWeight('scale-1', '10.5 kg');
      await provider.updateWeight('scale-2', '20.0 kg');

      provider.close();

      expect(mockChannel.detach).toHaveBeenCalledTimes(2);
      expect(mockRealtime.close).toHaveBeenCalled();
    });

    it('should handle close when no channels exist', () => {
      provider.close();

      expect(mockRealtime.close).toHaveBeenCalled();
    });
  });

  describe('connection recovery', () => {
    it('should attempt to recover connection', () => {
      const recoverCallback = (Ably.Realtime as jest.MockedClass<typeof Ably.Realtime>).mock
        .calls[0][0] as any;
      const recover = recoverCallback?.recover;

      if (recover) {
        const mockCallback = jest.fn();
        recover({} as any, mockCallback);

        expect(mockCallback).toHaveBeenCalledWith(true);
      }
    });
  });

  describe('error handling', () => {
    it('should handle connection failure', () => {
      // Get the failed event handler
      const failedHandler = mockConnection.on.mock.calls.find(
        (call: any) => call[0] === 'failed',
      )?.[1];

      if (failedHandler) {
        const error = new Error('Connection failed');
        expect(() => failedHandler(error)).not.toThrow();
      }
    });

    it('should handle disconnection', () => {
      // Get the disconnected event handler
      const disconnectedHandler = mockConnection.on.mock.calls.find(
        (call: any) => call[0] === 'disconnected',
      )?.[1];

      if (disconnectedHandler) {
        expect(() => disconnectedHandler()).not.toThrow();
      }
    });
  });
});
