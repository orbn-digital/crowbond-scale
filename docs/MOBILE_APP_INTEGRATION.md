# Mobile App Integration Guide

## Overview

The Crowbond Scales service publishes real-time weight data from XTREM industrial scales to Ably channels. Mobile applications can subscribe to these channels to receive live weight updates and scale status information.

## Architecture

```
┌──────────────┐      Ably Realtime      ┌─────────────┐
│ Scale Service├─────────────────────────►│ Ably Cloud  │
└──────────────┘     Publishes to         └──────┬──────┘
                    scale-{scaleId}                │
                                                   │ Subscribe
                                                   ▼
                                          ┌─────────────────┐
                                          │   Mobile App    │
                                          └─────────────────┘
```

## Quick Start

### 1. Install Ably SDK

#### React Native

```bash
npm install ably
```

### 2. Connect to Ably

```javascript
// React Native Example
import Ably from 'ably';

const client = new Ably.Realtime({ authUrl: '{API_ENDPOINT}/users/ably-token' });

client.connection.on('connected', () => {
  console.log('Connected to Ably');
});
```

### 3. Discover Online Scales (Presence)

The service now uses Ably Presence on a global `scales` channel. Presence events are published by the service client; each event’s data includes the scale id: `{ id, isConnected, lastSeen, lastActivity, errorCount, timestamp }`.

```javascript
// Presence-based discovery
const discovery = client.channels.get('scales');

// Bootstrap current online scales
const members = await discovery.presence.get();
const onlineScaleIds = members.map((m) => m.data?.id);

// React to real-time changes
discovery.presence.subscribe('enter', (presenceMsg) => {
  const scaleId = presenceMsg.data?.id; // use data.id as the source of truth
  console.log('Scale online:', scaleId, presenceMsg.data);
});

discovery.presence.subscribe('update', (presenceMsg) => {
  const scaleId = presenceMsg.data?.id;
  console.log('Scale status updated:', scaleId, presenceMsg.data);
});

discovery.presence.subscribe('leave', (presenceMsg) => {
  const scaleId = presenceMsg.data?.id;
  console.log('Scale offline:', scaleId);
});
```

### 4. Subscribe to a Specific Scale Channel

```javascript
// Subscribe to a specific scale
// You can select a scaleId from presence discovery (above)
const scaleId = '494189'; // Example serial number
const channel = client.channels.get(`scale-${scaleId}`);

// Listen for weight updates
channel.subscribe('weight-update', (message) => {
  console.log('Weight:', message.data);
  // { scaleId: "494189", weight: "10.5 kg", timestamp: "2024-01-01T00:00:00.000Z" }
});

// Listen for status updates (immediate on connect/disconnect + periodic)
channel.subscribe('status-update', (message) => {
  console.log('Status:', message.data);
  // { id: "494189", isConnected: true, ... }
});
```

## Channel Structure

### Channel Naming

- **Format**: `scale-{scaleId}`
- **Example**: `scale-494189`
- The `scaleId` is the scale's serial number (automatically retrieved from the scale)

### Events

#### 1. `weight-update`

Published whenever the weight on the scale changes.

```json
{
  "scaleId": "494189",
  "weight": "10.500 kg",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

#### 2. `status-update`

Published immediately on connect/disconnect and then every 30 seconds with health information.

```json
{
  "id": "494189",
  "isConnected": true,
  "lastSeen": "2024-01-01T12:00:00.000Z",
  "errorCount": 0,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Implementation Examples

### React Native Full Example

```javascript
import React, { useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import Ably from 'ably';

const ScaleDisplay = ({ scaleId, ablyApiKey }) => {
  const [weight, setWeight] = useState('0.000 kg');
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    const client = new Ably.Realtime({
      key: ablyApiKey,
      clientId: `mobile-user-${Date.now()}`,
    });

    // Discover presence first (optional)
    const discovery = client.channels.get('scales');
    discovery.presence.subscribe('enter', (p) => console.log('Online:', p.clientId));
    discovery.presence.subscribe('leave', (p) => console.log('Offline:', p.clientId));

    const channel = client.channels.get(`scale-${scaleId}`);

    // Subscribe to weight updates
    channel.subscribe('weight-update', (message) => {
      setWeight(message.data.weight);
      setLastUpdate(new Date(message.data.timestamp));
    });

    // Subscribe to status updates (immediate + periodic)
    channel.subscribe('status-update', (message) => {
      setIsConnected(message.data.isConnected);
    });

    // Connection status
    client.connection.on('connected', () => {
      console.log('Connected to Ably');
    });

    client.connection.on('disconnected', () => {
      console.log('Disconnected from Ably');
      setIsConnected(false);
    });

    // Cleanup
    return () => {
      channel.unsubscribe();
      client.close();
    };
  }, [scaleId, ablyApiKey]);

  return (
    <View>
      <Text>Scale: {scaleId}</Text>
      <Text>Weight: {weight}</Text>
      <Text>Status: {isConnected ? 'Connected' : 'Disconnected'}</Text>
      <Text>Last Update: {lastUpdate?.toLocaleTimeString() || 'Never'}</Text>
    </View>
  );
};

export default ScaleDisplay;
```
## Multiple Scales Support (ignore for now)

To monitor multiple scales simultaneously:

```javascript
const scaleIds = ['494189', '494190', '494191'];
const channels = {};

scaleIds.forEach((scaleId) => {
  const channel = client.channels.get(`scale-${scaleId}`);
  channels[scaleId] = channel;

  channel.subscribe('weight-update', (message) => {
    console.log(`Scale ${scaleId}: ${message.data.weight}`);
    // Update UI for specific scale
  });
});
```


## Error Handling

```javascript
channel
  .subscribe('weight-update', (message) => {
    // Handle weight update
  })
  .on('failed', (stateChange) => {
    console.error('Subscription failed:', stateChange.reason);
    // Retry logic
    setTimeout(() => {
      channel.subscribe('weight-update', handleWeight);
    }, 5000);
  });

client.connection.on('failed', () => {
  console.error('Connection failed');
  // Show offline UI
});

client.connection.on('suspended', () => {
  console.warn('Connection suspended, will auto-recover');
  // Show reconnecting UI
});

```

## Online Status Logic (Client)

- Prefer presence events (`enter`/`update`/`leave`) on `scales` to determine which scales are online.
- For a subscribed scale channel, treat it as online when:
  - Latest `status-update.isConnected === true`, and
  - Message is fresh: within 2 × `HEALTH_CHECK_INTERVAL` (default 60s).
- If no `status-update` is received in time, mark the scale as unknown/offline and surface a reconnect hint.

## HTTP Fallback

You can also poll the service’s `/health` endpoint to bootstrap or sanity-check state. It returns an array of `scales` with their latest status.
```

## Best Practices

### 1. Connection Management

- Use a single Ably client instance for all scales
- Implement reconnection logic for network failures
- Close connections when app goes to background

