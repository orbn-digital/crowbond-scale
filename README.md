# Crowbond Scales Service

Production-ready Node.js service for XTREM industrial scales network communication with real-time data streaming.

## Features

- **Multi-scale Support**: Connect and manage multiple XTREM scales simultaneously
- **Real-time Streaming**: Stream weight data via Ably to connected clients
- **TypeScript**: Fully typed for better developer experience and reliability
- **Comprehensive Testing**: Unit and integration tests with Jest
- **Production Ready**: Includes logging, monitoring, health checks, and auto-restart
- **New Relic APM**: Built-in application performance monitoring
- **Error Recovery**: Automatic reconnection with exponential backoff
- **Health Endpoints**: HTTP endpoints for health checks and metrics

## Prerequisites

- Node.js >= 16.0.0
- npm or yarn
- PM2 (for production deployment)
- XTREM scales on the network
- Ably account for real-time streaming
- New Relic account for monitoring

## Installation

```bash
npm install
```

## Configuration

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Update `.env` with your configuration:
- `ABLY_API_KEY`: Your Ably API key
- `NEW_RELIC_LICENSE_KEY`: Your New Relic license key
- `DEVICE_API_BASE_URL`: Base URL for the device service (for example `https://devices.api/v1/`)
- `SCALE_DEVICE_TYPE`: Device type to request from the device service (default: `Scale`)
- `SCALE_IPS`: Comma-separated list of scale IP addresses (used as a fallback when discovery fails)
- `LOCAL_PORT`: Local UDP port for receiving data (default: 5555)
- `REMOTE_PORT`: Scale UDP port (default: 4444)

## Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run start:dev

# Run TypeScript compiler check
npm run typecheck

# Run linter
npm run lint

# Format code
npm run format
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Building

```bash
# Build TypeScript to JavaScript
npm run build

# Clean build artifacts
npm run clean
```

## Production Deployment

### Using PM2

```bash
# Build the application
npm run build

# Start with PM2
npm run pm2:start

# View logs
npm run pm2:logs

# Stop service
npm run pm2:stop

# Restart service
npm run pm2:restart
```

### Direct Node.js

```bash
# Build and start
npm run build
npm run start:prod
```

## API Endpoints

### Health Check
```
GET /health

Response:
{
  "status": "healthy" | "unhealthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "scales": [
    {
      "id": "scale-1",
      "ip": "192.168.1.100",
      "isConnected": true,
      "lastSeen": "2024-01-01T00:00:00.000Z",
      "errorCount": 0
    }
  ]
}
```

### Metrics
```
GET /metrics

Response:
{
  "scales_total": 2,
  "scales_connected": 2,
  "scales_disconnected": 0,
  "total_errors": 0
}
```

## Real-time Data

Weight updates are published to Ably channels:
- Channel: `scale-{scaleId}`
- Event: `weight-update`
- Data: `{ scaleId, weight, timestamp }`

Status updates are published to:
- Channel: `scale-{scaleId}`
- Event: `status-update`
- Data: `{ id, ip, isConnected, lastSeen, errorCount, timestamp }`

## Architecture

```
┌─────────────┐      UDP       ┌──────────────┐
│ XTREM Scale ├───────────────►│              │
└─────────────┘                │              │     ┌──────────┐
                               │ Scale        ├────►│   Ably   │
┌─────────────┐      UDP       │ Manager      │     └──────────┘
│ XTREM Scale ├───────────────►│              │
└─────────────┘                │              │     ┌──────────┐
                               │              ├────►│ New Relic│
┌─────────────┐      UDP       │              │     └──────────┘
│ XTREM Scale ├───────────────►│              │
└─────────────┘                └──────────────┘
                                      │
                                      ▼
                               ┌──────────────┐
                               │ Health API   │
                               └──────────────┘
```

## Protocol

The XTREM scale uses a proprietary protocol with commands wrapped in STX/ETX characters:

- **Start streaming**: `\u000200FFE10110000\u0003\r\n`
- **Stop streaming**: `\u000200FFE10100000\u0003\r\n`
- Weight data format: `0100r01071AW   0.000kgT   0.0...`
- Default ports: Local 5555, Remote 4444
- The scale must be configured for network communication

## Project Structure

```
src/
├── config/           # Configuration management
├── scales/           # Scale communication logic
│   └── XtremScale.ts
├── services/         # Business logic
│   ├── ScaleManager.ts
│   └── realtime/
│       ├── RealTimeProvider.ts
│       └── AblyProvider.ts
├── types/           # TypeScript type definitions
├── utils/           # Utility functions
│   └── logger.ts
└── index.ts         # Application entry point

tests/
├── unit/            # Unit tests
└── integration/     # Integration tests
```

## Monitoring

The service integrates with New Relic APM for monitoring:
- Application performance metrics
- Error tracking
- Transaction tracing
- Custom metrics for scale operations

## Troubleshooting

### Scale Not Connecting
1. Verify scale IP is reachable: `ping <scale_ip>`
2. Check firewall rules for UDP ports
3. Verify scale is configured for UDP communication
4. Check logs: `npm run pm2:logs`

### No Weight Data
1. Ensure scale is powered on and connected to network
2. Verify UDP ports match scale configuration
3. Check scale protocol settings
4. Review debug logs with `LOG_LEVEL=debug`

### High Memory Usage
1. Check number of connected scales
2. Review streaming frequency
3. Monitor with New Relic APM
4. Adjust PM2 memory limits if needed

## License

MIT
