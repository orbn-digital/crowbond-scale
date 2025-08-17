import * as dgram from 'dgram';
import { XtremScale } from '../../src/scales/XtremScale';
import { ScaleConfig } from '../../src/types/scale.types';

describe('UDP Communication Integration Tests', () => {
  let mockScaleServer: dgram.Socket;
  let scale: XtremScale;
  const TEST_PORT = 6666;
  const SCALE_PORT = 6667;
  
  beforeAll((done) => {
    // Create a mock UDP server to simulate the scale
    mockScaleServer = dgram.createSocket('udp4');
    
    mockScaleServer.on('message', (msg, rinfo) => {
      const message = msg.toString();
      
      // Simulate scale responses based on commands
      if (message.includes('FFE101100')) {
        // Start streaming command - send weight data
        const weightResponse = Buffer.from('\u00020100r01071AW   12.345kg\u0003');
        mockScaleServer.send(weightResponse, rinfo.port, rinfo.address);
      } else if (message.includes('FFE101000')) {
        // Stop streaming command - send confirmation
        const confirmResponse = Buffer.from('\u00020100e101100054\u0003');
        mockScaleServer.send(confirmResponse, rinfo.port, rinfo.address);
      }
    });
    
    mockScaleServer.bind(SCALE_PORT, 'localhost', () => {
      done();
    });
  });
  
  afterAll((done) => {
    mockScaleServer.close(() => {
      done();
    });
  });
  
  beforeEach(() => {
    const config: ScaleConfig = {
      ip: 'localhost',
      localPort: TEST_PORT,
      remotePort: SCALE_PORT,
      id: 'test-scale',
    };
    scale = new XtremScale(config);
  });
  
  afterEach(async () => {
    await scale.close();
  });
  
  describe('Real UDP Communication', () => {
    it('should establish connection and receive weight data', async () => {
      await scale.connect();
      
      const weightPromise = new Promise((resolve) => {
        scale.on('weight', (weightData) => {
          resolve(weightData);
        });
      });
      
      await scale.startStreaming();
      
      const weight = await weightPromise;
      expect(weight).toMatchObject({
        weight: '12.345',
        unit: 'kg',
        display: '12.345 kg',
      });
      
      await scale.stopStreaming();
    });
    
    it('should handle multiple weight updates', async () => {
      await scale.connect();
      
      const weights: any[] = [];
      scale.on('weight', (weightData) => {
        weights.push(weightData);
      });
      
      await scale.startStreaming();
      
      // Send multiple weight updates
      for (let i = 0; i < 3; i++) {
        const weightResponse = Buffer.from(`\u00020100r01071AW   ${10 + i}.000kg\u0003`);
        mockScaleServer.send(weightResponse, TEST_PORT, 'localhost');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      expect(weights.length).toBeGreaterThanOrEqual(3);
      await scale.stopStreaming();
    });
    
    it('should handle connection loss and recovery', async () => {
      await scale.connect();
      
      // Simulate connection loss by closing the mock server
      mockScaleServer.close();
      
      // Wait for error to be detected
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Recreate the mock server
      mockScaleServer = dgram.createSocket('udp4');
      mockScaleServer.bind(SCALE_PORT, 'localhost');
      
      // Try to send command (should attempt reconnection)
      const status = scale.getStatus();
      expect(status.errorCount).toBeGreaterThan(0);
    });
  });
  
  describe('Protocol Compliance', () => {
    it('should format commands with STX and ETX correctly', async () => {
      await scale.connect();
      
      const receivedMessages: string[] = [];
      mockScaleServer.removeAllListeners('message');
      mockScaleServer.on('message', (msg) => {
        receivedMessages.push(msg.toString());
      });
      
      await scale.startStreaming();
      
      expect(receivedMessages.length).toBeGreaterThan(0);
      const message = receivedMessages[0];
      expect(message.charCodeAt(0)).toBe(2); // STX
      expect(message.includes('\u0003')).toBe(true); // ETX
    });
    
    it('should parse different message formats', async () => {
      await scale.connect();
      
      const messages: any[] = [];
      scale.on('weight', (data) => messages.push({ type: 'weight', data }));
      scale.on('status', (data) => messages.push({ type: 'status', data }));
      
      // Send weight message
      const weightMsg = Buffer.from('\u00020100r01071AW   5.000kg\u0003');
      mockScaleServer.send(weightMsg, TEST_PORT, 'localhost');
      
      // Send status message
      const statusMsg = Buffer.from('\u00020100e101100054\u0003');
      mockScaleServer.send(statusMsg, TEST_PORT, 'localhost');
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(messages.some(m => m.type === 'weight')).toBe(true);
      expect(messages.some(m => m.type === 'status')).toBe(true);
    });
  });
  
  describe('Error Handling', () => {
    it('should timeout when no response received', async () => {
      await scale.connect();
      
      // Temporarily remove message handler to simulate no response
      mockScaleServer.removeAllListeners('message');
      
      await expect(scale.getWeight(500)).rejects.toThrow('Timeout waiting for weight data');
    });
    
    it('should handle malformed messages gracefully', async () => {
      await scale.connect();
      
      const errorHandler = jest.fn();
      scale.on('error', errorHandler);
      
      // Send malformed message
      const malformedMsg = Buffer.from('INVALID_MESSAGE');
      mockScaleServer.send(malformedMsg, TEST_PORT, 'localhost');
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Should not crash
      expect(errorHandler).not.toHaveBeenCalled();
    });
  });
});