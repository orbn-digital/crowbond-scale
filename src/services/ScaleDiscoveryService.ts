import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { ScaleConfig } from '../types/scale.types';
import { config, getScaleConfigs as getConfiguredScaleConfigs } from '../config';
import { createLogger } from '../utils/logger';

interface DeviceBrief {
  id?: string;
  name?: string;
  type?: string;
  networkAddress?: string;
  status?: string;
}

const logger = createLogger('ScaleDiscoveryService');

export async function discoverScaleConfigs(): Promise<ScaleConfig[]> {
  const baseUrl = config.deviceService.baseUrl;

  if (!baseUrl) {
    logger.warn('Device API base URL not configured; using SCALE_IPS fallback');
    return getConfiguredScaleConfigs();
  }

  try {
    logger.info(
      { baseUrl, type: config.deviceService.scaleType },
      'Fetching scale devices from API',
    );
    const devices = await fetchDevicesFromApi(baseUrl, config.deviceService.scaleType);
    if (devices.length === 0) {
      logger.warn({ baseUrl }, 'Device API returned no scale devices');
      return getConfiguredScaleConfigs();
    }

    logger.info(
      {
        baseUrl,
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          networkAddress: device.networkAddress,
          status: device.status,
        })),
      },
      'Device API payload received',
    );

    logger.info({ baseUrl, deviceCount: devices.length }, 'Discovered scales from device API');
    return mapDevicesToScaleConfigs(devices);
  } catch (error) {
    logger.error({ err: error, baseUrl }, 'Failed to fetch scale devices from API');
    const fallback = getConfiguredScaleConfigs();
    if (fallback.length > 0) {
      logger.info({ fallbackCount: fallback.length }, 'Using SCALE_IPS fallback');
    }
    return fallback;
  }
}

async function fetchDevicesFromApi(baseUrl: string, type: number): Promise<DeviceBrief[]> {
  const url = buildDevicesUrl(baseUrl, type);
  const response = await requestJson(url);

  if (!Array.isArray(response)) {
    throw new Error('Device API response is not an array');
  }

  return response.filter((device): device is DeviceBrief => {
    return Boolean(
      device && typeof device.networkAddress === 'string' && device.networkAddress.trim(),
    );
  });
}

function buildDevicesUrl(baseUrl: string, type: number): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('devices', normalizedBaseUrl);
  url.searchParams.set('type', type.toString());
  return url;
}

function requestJson(url: URL): Promise<unknown> {
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      const { statusCode } = response;
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      response.on('error', (error) => {
        reject(error);
      });

      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');

        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          const snippet = body.slice(0, 200);
          reject(new Error(`Device API returned ${statusCode ?? 'unknown'}: ${snippet}`));
          return;
        }

        if (!body.trim()) {
          resolve([]);
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          reject(new Error(`Failed to parse device API response: ${message}`));
        }
      });
    });

    request.on('error', (error) => {
      reject(error);
    });

    const timeoutMs = config.scales.timeout;
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Device API request timed out after ${timeoutMs}ms`));
    });
  });
}

function mapDevicesToScaleConfigs(devices: DeviceBrief[]): ScaleConfig[] {
  const uniqueDevices = dedupeByAddress(devices);

  return uniqueDevices.map((device, index) => {
    return {
      ip: device.networkAddress?.trim() ?? '',
      localPort: config.scales.localPort + index,
      remotePort: config.scales.remotePort,
      id: device.id || device.name || `scale-${index + 1}`,
    };
  });
}

function dedupeByAddress(devices: DeviceBrief[]): DeviceBrief[] {
  const seen = new Set<string>();
  const unique: DeviceBrief[] = [];

  for (const device of devices) {
    const address = device.networkAddress?.trim();
    if (!address) {
      continue;
    }

    if (seen.has(address)) {
      continue;
    }

    seen.add(address);
    unique.push(device);
  }

  return unique;
}
