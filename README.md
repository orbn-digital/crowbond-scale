# XTREM Scale Node.js Client

Node.js implementation for connecting to XTREM scales via UDP network connection.

## Installation

No external dependencies required - uses Node.js built-in `dgram` module for UDP communication.

```bash
npm install
```

## Usage

### Command Line

```bash
# Basic usage with IP address (uses default ports 5555/4444)
node xtrem-scale.js 192.168.1.100

# Custom ports
node xtrem-scale.js 192.168.1.100 5555 4444
```

### As a Module

```javascript
const XtremScale = require('./xtrem-scale');

async function example() {
  const scale = new XtremScale('192.168.1.100', 5555, 4444);
  
  try {
    await scale.connect();
    const weight = await scale.getWeight();
    console.log('Weight:', weight.display);
  } finally {
    await scale.close();
  }
}
```

## API

### Constructor
```javascript
new XtremScale(scaleIP, localPort = 5555, remotePort = 4444)
```

### Methods

- `connect()` - Establish UDP connection to the scale
- `getWeight(timeout = 5000)` - Get current weight reading
- `startStreaming()` - Start continuous weight data stream
- `stopStreaming()` - Stop weight data stream
- `close()` - Close the connection

## Protocol

The XTREM scale uses a proprietary protocol with commands wrapped in STX/ETX characters:

- **Start streaming**: `\u000200FFE10110000\u0003\r\n`
- **Stop streaming**: `\u000200FFE10100000\u0003\r\n`

## Notes

- Default ports: Local 5555, Remote 4444
- The scale must be configured for network communication
- Weight data format: `0100r01071AW   0.000kgT   0.0...`
- Ensure firewall allows UDP traffic on specified ports
- The scale sends continuous weight updates when streaming is started