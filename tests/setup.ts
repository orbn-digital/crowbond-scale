import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set test timeouts
jest.setTimeout(10000);

// Mock New Relic to avoid requiring a specific Node version and agent init
jest.mock('newrelic', () => ({
  recordMetric: jest.fn(),
  noticeError: jest.fn(),
  addCustomAttribute: jest.fn(),
  incrementMetric: jest.fn(),
  startSegment: jest.fn((_name: string, _rec: boolean, handler: any) => handler()),
  startBackgroundTransaction: jest.fn((_name: string, _group: string, handler: any) => handler()),
  getTransaction: jest.fn(() => ({ end: jest.fn() })),
}));

// Mock logger in tests to reduce noise
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      fatal: jest.fn(),
    })),
  },
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  })),
}));
