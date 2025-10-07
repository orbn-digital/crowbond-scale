import * as dotenv from 'dotenv';
import Joi from 'joi';
import { ScaleConfig } from '../types/scale.types';

dotenv.config();

const configSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
  SERVICE_PORT: Joi.number().default(3000),

  // Ably configuration
  ABLY_API_KEY: Joi.string().required(),

  // New Relic configuration
  NEW_RELIC_LICENSE_KEY: Joi.string().required(),
  NEW_RELIC_APP_NAME: Joi.string().default('Crowbond-Scales'),
  NEW_RELIC_LOG_LEVEL: Joi.string().default('info'),

  // Scale configuration
  SCALE_IPS: Joi.string().default(''),
  LOCAL_PORT: Joi.number().default(5555),
  REMOTE_PORT: Joi.number().default(4444),
  DEVICE_API_BASE_URL: Joi.string().uri().allow('').default(''),
  SCALE_DEVICE_TYPE: Joi.string().default('Scale'),

  // Operational configuration
  SCALE_TIMEOUT: Joi.number().default(5000),
  RETRY_ATTEMPTS: Joi.number().default(3),
  RETRY_DELAY: Joi.number().default(1000),
  HEALTH_CHECK_INTERVAL: Joi.number().default(30000),
  HEARTBEAT_INTERVAL: Joi.number().default(2000), // Check every 2 seconds
  INACTIVITY_TIMEOUT: Joi.number().default(5000), // Mark offline after 5 seconds
  VERIFICATION_TIMEOUT: Joi.number().default(2000), // 2 seconds to verify connection
}).unknown();

const { error, value: envVars } = configSchema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const config = {
  env: envVars.NODE_ENV as string,
  logLevel: envVars.LOG_LEVEL as string,
  servicePort: envVars.SERVICE_PORT as number,

  ably: {
    apiKey: envVars.ABLY_API_KEY as string,
  },

  newRelic: {
    licenseKey: envVars.NEW_RELIC_LICENSE_KEY as string,
    appName: envVars.NEW_RELIC_APP_NAME as string,
    logLevel: envVars.NEW_RELIC_LOG_LEVEL as string,
  },

  scales: {
    ips: envVars.SCALE_IPS ? (envVars.SCALE_IPS as string).split(',').map((ip) => ip.trim()) : [],
    localPort: envVars.LOCAL_PORT as number,
    remotePort: envVars.REMOTE_PORT as number,
    timeout: envVars.SCALE_TIMEOUT as number,
  },

  deviceService: {
    baseUrl: (envVars.DEVICE_API_BASE_URL as string) || undefined,
    scaleType: envVars.SCALE_DEVICE_TYPE as number,
  },

  operational: {
    retryAttempts: envVars.RETRY_ATTEMPTS as number,
    retryDelay: envVars.RETRY_DELAY as number,
    healthCheckInterval: envVars.HEALTH_CHECK_INTERVAL as number,
    heartbeatInterval: envVars.HEARTBEAT_INTERVAL as number,
    inactivityTimeout: envVars.INACTIVITY_TIMEOUT as number,
    verificationTimeout: envVars.VERIFICATION_TIMEOUT as number,
  },
};

export function getScaleConfigs(): ScaleConfig[] {
  return config.scales.ips.map((ip, index) => ({
    ip,
    localPort: config.scales.localPort + index, // Unique port for each scale
    remotePort: config.scales.remotePort,
    id: `scale-${index + 1}`,
  }));
}
