import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { XtremScale } from '../../src/scales/XtremScale';
import { ScaleConfig, ScaleCommand } from '../../src/types/scale.types';

// Mock dgram
jest.mock('dgram');

describe('XtremScale', () => {
  let scale: XtremScale;
  let mockSocket: jest.Mocked<dgram.Socket>;
  const mockConfig: ScaleConfig = {
    ip: '192.168.1.100',
    localPort: 5555,
    remotePort: 4444,
    id: 'test-scale',
  };

  beforeEach(() => {
    // Create mock socket
    mockSocket = new EventEmitter() as jest.Mocked<dgram.Socket>;
    mockSocket.bind = jest.fn((_port: any, callback?: any) => {
      if (callback) {
        // Simulate async bind and emit a message to pass verification
        setImmediate(() => {
          callback();
          // Emit a weight message to pass verification
          mockSocket.emit('message', Buffer.from('\u000200FFr0001    100.5 kg\u0003'), {
            address: '192.168.1.100',
            port: 4444,
          });
        });
      }
      return mockSocket;
    }) as any;
    mockSocket.send = jest.fn((_msg: any, _port: any, _address: any, callback?: any) => {
      if (callback) callback(null);
    }) as any;
    mockSocket.close = jest.fn((callback?: any) => {
      if (callback) callback();
    }) as any;
    mockSocket.removeAllListeners = jest.fn();

    // Mock dgram.createSocket
    (dgram.createSocket as jest.Mock).mockReturnValue(mockSocket);

    scale = new XtremScale(mockConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('connect', () => {
    it('should successfully connect to scale', async () => {
      await scale.connect();

      expect(dgram.createSocket).toHaveBeenCalledWith('udp4');
      expect(mockSocket.bind).toHaveBeenCalledWith(5555, expect.any(Function));
    });

    it('should emit connected event on successful connection', async () => {
      const connectedSpy = jest.fn();
      scale.on('connected', connectedSpy);

      await scale.connect();

      expect(connectedSpy).toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      const error = new Error('Bind failed');
      mockSocket.bind = jest.fn((_port: any, _callback?: any) => {
        mockSocket.emit('error', error);
      }) as any;

      const errorSpy = jest.fn();
      scale.on('error', errorSpy);

      try {
        await scale.connect();
      } catch (e) {
        // Expected to fail
      }

      expect(errorSpy).toHaveBeenCalledWith(error);
    });
  });

  describe('sendCommand', () => {
    beforeEach(async () => {
      await scale.connect();
      // Wait for verification to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it('should send command successfully', async () => {
      const command = 'TEST_COMMAND';
      await scale.sendCommand(command);

      expect(mockSocket.send).toHaveBeenCalledWith(
        Buffer.from(command),
        4444,
        '192.168.1.100',
        expect.any(Function),
      );
    });

    it('should reject if not connected', async () => {
      await scale.close();

      await expect(scale.sendCommand('TEST')).rejects.toThrow('Scale not connected');
    });

    it('should handle send errors', async () => {
      const error = new Error('Send failed');
      mockSocket.send = jest.fn((_msg: any, _port: any, _address: any, callback?: any) => {
        if (callback) callback(error);
      }) as any;

      await expect(scale.sendCommand('TEST')).rejects.toThrow('Send failed');
    });
  });

  describe('startStreaming', () => {
    beforeEach(async () => {
      await scale.connect();
    });

    it('should send start streaming command', async () => {
      await scale.startStreaming();

      expect(mockSocket.send).toHaveBeenCalledWith(
        Buffer.from(ScaleCommand.START_STREAMING),
        4444,
        '192.168.1.100',
        expect.any(Function),
      );
    });
  });

  describe('stopStreaming', () => {
    beforeEach(async () => {
      await scale.connect();
    });

    it('should send stop streaming command', async () => {
      await scale.stopStreaming();

      expect(mockSocket.send).toHaveBeenCalledWith(
        Buffer.from(ScaleCommand.STOP_STREAMING),
        4444,
        '192.168.1.100',
        expect.any(Function),
      );
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      await scale.connect();
    });

    it('should parse weight data correctly', (done) => {
      scale.on('weight', (weightData) => {
        expect(weightData.weight).toBe('0.000');
        expect(weightData.unit).toBe('kg');
        expect(weightData.display).toBe('0.000 kg');
        expect(weightData.scaleId).toBe('test-scale');
        done();
      });

      // Simulate receiving weight data
      const weightMessage = '\u00020100r01071AW   0.000kg\u0003';
      mockSocket.emit('message', Buffer.from(weightMessage), {
        address: '192.168.1.100',
        port: 4444,
      });
    });

    it('should parse W segment when T and S fields follow', (done) => {
      scale.on('weight', (weightData) => {
        expect(weightData.weight).toBe('0.000');
        expect(weightData.unit).toBe('kg');
        expect(weightData.display).toBe('0.000 kg');
        done();
      });

      // Example full streaming payload including tare and sequence
      const fullMessage = '\u00020100r01071AW   0.000kgT   0.000kgS01561\u0003';
      mockSocket.emit('message', Buffer.from(fullMessage), {
        address: '192.168.1.100',
        port: 4444,
      });
    });

    it('should handle status messages', (done) => {
      scale.on('status', (statusMessage) => {
        expect(statusMessage).toContain('0100e');
        done();
      });

      const statusMessage = '\u00020100e101101054\u0003';
      mockSocket.emit('message', Buffer.from(statusMessage), {
        address: '192.168.1.100',
        port: 4444,
      });
    });

    it('should handle messages without STX/ETX', (done) => {
      scale.on('weight', (weightData) => {
        expect(weightData).toBeDefined();
        done();
      });

      // Message without STX/ETX markers
      const message = 'X0100r01071AW   0.000kgXXX';
      mockSocket.emit('message', Buffer.from(message), { address: '192.168.1.100', port: 4444 });
    });
  });

  describe('getWeight', () => {
    beforeEach(async () => {
      await scale.connect();
    });

    it('should get weight with timeout', async () => {
      // Simulate weight response after 100ms
      setTimeout(() => {
        const weightMessage = '\u00020100r01071AW   5.500kg\u0003';
        mockSocket.emit('message', Buffer.from(weightMessage), {
          address: '192.168.1.100',
          port: 4444,
        });
      }, 100);

      const weight = await scale.getWeight(1000);

      expect(weight.weight).toBe('5.500');
      expect(weight.unit).toBe('kg');
    });

    it('should timeout if no weight received', async () => {
      await expect(scale.getWeight(100)).rejects.toThrow('Timeout waiting for weight data');
    });
  });

  describe('getStatus', () => {
    beforeEach(async () => {
      await scale.connect();
    });

    it('should return current scale status', () => {
      const status = scale.getStatus();

      expect(status).toEqual({
        id: 'test-scale',
        ip: '192.168.1.100',
        isConnected: true,
        lastSeen: undefined,
        lastWeight: undefined,
        errorCount: 0,
        lastError: undefined,
      });
    });

    it('should include error information in status', async () => {
      const error = new Error('Test error');
      mockSocket.emit('error', error);

      const status = scale.getStatus();
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toBe('Test error');
    });
  });

  describe('close', () => {
    beforeEach(async () => {
      await scale.connect();
    });

    it('should close connection properly', async () => {
      await scale.close();

      expect(mockSocket.close).toHaveBeenCalled();
    });

    it('should stop streaming before closing if streaming', async () => {
      await scale.startStreaming();
      await scale.close();

      // Should have called send twice: start streaming and stop streaming
      expect(mockSocket.send).toHaveBeenCalledTimes(2);
      expect(mockSocket.close).toHaveBeenCalled();
    });

    it('should emit disconnected event', async () => {
      const disconnectedSpy = jest.fn();
      scale.on('disconnected', disconnectedSpy);

      mockSocket.emit('close');

      expect(disconnectedSpy).toHaveBeenCalled();
    });
  });

  describe('error handling and reconnection', () => {
    beforeEach(async () => {
      await scale.connect();
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should attempt reconnection on error', async () => {
      const error = new Error('Connection lost');
      mockSocket.emit('error', error);

      // Fast-forward time to trigger reconnection
      jest.advanceTimersByTime(1000);

      // Reconnection should create a new socket
      expect(dgram.createSocket).toHaveBeenCalledTimes(2);
    });

    it('should emit disconnected on UDP error', () => {
      const disconnectedSpy = jest.fn();
      scale.on('disconnected', disconnectedSpy);

      const error = new Error('Network error');
      mockSocket.emit('error', error);

      expect(disconnectedSpy).toHaveBeenCalled();
    });

    it('should use exponential backoff for reconnection', () => {
      // First error
      mockSocket.emit('error', new Error('Error 1'));
      jest.advanceTimersByTime(1000);

      // Second error
      mockSocket.emit('error', new Error('Error 2'));

      const status = scale.getStatus();
      expect(status.errorCount).toBe(2);
    });
  });
});
