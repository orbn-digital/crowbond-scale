import { PassThrough } from 'stream';
import http from 'node:http';

const fallbackConfigs = [
  { ip: '10.0.0.10', localPort: 5555, remotePort: 4444, id: 'fallback-1' },
];

const mockConfig = {
  deviceService: { baseUrl: '', scaleType: 'Scale' },
  scales: { ips: [], localPort: 5555, remotePort: 4444, timeout: 5000 },
};

const getScaleConfigsMock = jest.fn(() => fallbackConfigs);

jest.mock('@/config', () => ({
  config: mockConfig,
  getScaleConfigs: getScaleConfigsMock,
}));

jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// eslint-disable-next-line import/first
import { discoverScaleConfigs } from '@/services/ScaleDiscoveryService';

describe('discoverScaleConfigs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.deviceService.baseUrl = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns fallback configs when device API base URL is not configured', async () => {
    const configs = await discoverScaleConfigs();

    expect(configs).toBe(fallbackConfigs);
    expect(getScaleConfigsMock).toHaveBeenCalledTimes(1);
  });

  it('returns devices from API when request succeeds', async () => {
    mockConfig.deviceService.baseUrl = 'http://devices.test/api';

    const httpGetSpy = jest.spyOn(http, 'get') as jest.MockedFunction<typeof http.get>;
    httpGetSpy.mockImplementation((_requestUrl: any, options?: any, callback?: any) => {
      const responseStream = new PassThrough();
      const incoming = responseStream as unknown as http.IncomingMessage;
      incoming.statusCode = 200;

      const handler = typeof options === 'function' ? options : callback;
      handler?.(incoming);

      responseStream.end(
        JSON.stringify([
          { id: 'device-1', networkAddress: '192.168.0.10', name: 'Scale A' },
          { id: 'device-2', networkAddress: '192.168.0.11', name: 'Scale B' },
        ]),
      );

      return {
        setTimeout: jest.fn().mockReturnThis(),
        on: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      } as unknown as http.ClientRequest;
    });

    const configs = await discoverScaleConfigs();

    expect(httpGetSpy).toHaveBeenCalled();
    const [requestUrl] = httpGetSpy.mock.calls[0];
    expect(requestUrl).toBeInstanceOf(URL);
    expect((requestUrl as URL).toString()).toBe('http://devices.test/api/devices?type=Scale');
    expect(configs).toEqual([
      { ip: '192.168.0.10', localPort: 5555, remotePort: 4444, id: 'device-1' },
      { ip: '192.168.0.11', localPort: 5556, remotePort: 4444, id: 'device-2' },
    ]);
    expect(getScaleConfigsMock).not.toHaveBeenCalled();
  });

  it('falls back to env configs when API returns an error status', async () => {
    mockConfig.deviceService.baseUrl = 'http://devices.test/api';

    const httpGetSpy = jest.spyOn(http, 'get') as jest.MockedFunction<typeof http.get>;
    httpGetSpy.mockImplementation((_requestUrl: any, options?: any, callback?: any) => {
      const responseStream = new PassThrough();
      const incoming = responseStream as unknown as http.IncomingMessage;
      incoming.statusCode = 500;

      const handler = typeof options === 'function' ? options : callback;
      handler?.(incoming);

      responseStream.end('server error');

      return {
        setTimeout: jest.fn().mockReturnThis(),
        on: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      } as unknown as http.ClientRequest;
    });

    const configs = await discoverScaleConfigs();

    expect(configs).toBe(fallbackConfigs);
    expect(getScaleConfigsMock).toHaveBeenCalledTimes(1);
  });
});
