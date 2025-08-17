import pino from 'pino';
import { config } from '../config';

const pinoConfig: pino.LoggerOptions = {
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
};

// Use pretty printing in development
if (config.env === 'development') {
  pinoConfig.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(pinoConfig);

export function createLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}