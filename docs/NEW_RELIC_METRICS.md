# New Relic Monitoring and Metrics

## Overview

The Crowbond Scales service sends comprehensive structured events, custom metrics, and distributed traces to New Relic for monitoring and observability.

## Custom Events

### 1. WeightMeasurement
Sent whenever a scale reports a weight change.
```json
{
  "eventType": "WeightMeasurement",
  "scaleId": "494189",
  "weight": 10.5,
  "unit": "kg",
  "display": "10.5 kg",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 2. ScaleConnectionChange
Tracks scale connection/disconnection events.
```json
{
  "eventType": "ScaleConnectionChange",
  "scaleId": "494189",
  "connected": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 3. ScaleError
Records any scale-related errors.
```json
{
  "eventType": "ScaleError",
  "scaleId": "494189",
  "errorMessage": "Connection timeout",
  "errorName": "TimeoutError",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 4. HealthCheck
Periodic health status of all scales (every 30 seconds).
```json
{
  "eventType": "HealthCheck",
  "totalScales": 5,
  "connectedScales": 4,
  "disconnectedScales": 1,
  "totalErrors": 2,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 5. AblyPublish
Tracks real-time data publishing to Ably.
```json
{
  "eventType": "AblyPublish",
  "scaleId": "494189",
  "eventType": "weight-update",
  "success": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 6. ServiceStartup
Logged when the service starts.
```json
{
  "eventType": "ServiceStartup",
  "scaleCount": 5,
  "nodeVersion": "v18.0.0",
  "platform": "linux",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 7. ServiceShutdown
Logged when the service stops.
```json
{
  "eventType": "ServiceShutdown",
  "reason": "SIGTERM",
  "uptime": 3600,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Custom Metrics

### Scale Metrics
- `Custom/Scale/Weight` - Current weight reading (gauge)
- `Custom/Scale/{scaleId}/Weight` - Weight per scale (gauge)
- `Custom/Scale/{scaleId}/Connected` - Connection status (1 or 0)
- `Custom/Scale/{scaleId}/Errors` - Error count (counter)

### System Metrics
- `Custom/Scales/Total` - Total number of scales
- `Custom/Scales/Connected` - Number of connected scales
- `Custom/Scales/Disconnected` - Number of disconnected scales
- `Custom/Scales/TotalErrors` - Total error count across all scales

### UDP Communication Metrics
- `Custom/UDP/sent/Bytes` - Total bytes sent via UDP
- `Custom/UDP/received/Bytes` - Total bytes received via UDP
- `Custom/UDP/{scaleId}/sent/Count` - Message count sent per scale
- `Custom/UDP/{scaleId}/received/Count` - Message count received per scale

### Ably Publishing Metrics
- `Custom/Ably/weight-update/Success` - Successful weight updates published
- `Custom/Ably/weight-update/Failed` - Failed weight update attempts
- `Custom/Ably/status-update/Success` - Successful status updates published
- `Custom/Ably/status-update/Failed` - Failed status update attempts

## Distributed Tracing

### Transaction Segments
- `scale-initialization` - Tracks the entire scale initialization process
- `ably-publish-weight` - Tracks weight publishing to Ably
- HTTP health check endpoints are automatically traced

### Background Transactions
- Scale initialization and startup
- Health check execution
- Weight data processing

## Error Tracking

All errors are automatically captured with context:
- Scale ID
- Error type
- Stack trace
- Custom attributes (connection state, last weight, etc.)

## Dashboards and Alerts

### Recommended Dashboards

1. **Scale Overview Dashboard**
   - Real-time weight readings per scale
   - Connection status matrix
   - Error rate trends
   - UDP traffic volume

2. **Performance Dashboard**
   - Transaction response times
   - Ably publishing latency
   - UDP message processing rate
   - Health check execution time

3. **Error Dashboard**
   - Error rate by scale
   - Error types distribution
   - Connection failure patterns
   - Recovery success rate

### Recommended Alerts

1. **Scale Disconnection Alert**
   - Condition: `Custom/Scale/{scaleId}/Connected < 1` for > 5 minutes
   - Severity: Warning

2. **High Error Rate Alert**
   - Condition: `Custom/Scales/TotalErrors` > 10 per minute
   - Severity: Critical

3. **Ably Publishing Failure Alert**
   - Condition: `Custom/Ably/weight-update/Failed` > 5 per minute
   - Severity: Warning

4. **Service Down Alert**
   - Condition: No `HealthCheck` events for > 2 minutes
   - Severity: Critical

## NRQL Query Examples

### Get latest weight for all scales
```sql
SELECT latest(weight) as 'Current Weight', latest(unit) as 'Unit' 
FROM WeightMeasurement 
FACET scaleId 
SINCE 5 minutes ago
```

### Monitor connection stability
```sql
SELECT percentage(count(*), WHERE connected = true) as 'Uptime %' 
FROM ScaleConnectionChange 
FACET scaleId 
SINCE 1 hour ago
```

### Track weight changes over time
```sql
SELECT average(weight) 
FROM WeightMeasurement 
WHERE scaleId = '494189' 
TIMESERIES 1 minute 
SINCE 1 hour ago
```

### Analyze error patterns
```sql
SELECT count(*) 
FROM ScaleError 
FACET errorName, scaleId 
SINCE 1 day ago
```

### Monitor Ably publishing performance
```sql
SELECT percentage(count(*), WHERE success = true) as 'Success Rate' 
FROM AblyPublish 
FACET eventType 
SINCE 1 hour ago
```

## Configuration

The New Relic integration is configured via environment variables:
- `NEW_RELIC_LICENSE_KEY`: Your New Relic license key
- `NEW_RELIC_APP_NAME`: Application name (default: Crowbond-Scales)
- `NEW_RELIC_LOG_LEVEL`: Logging level (default: info)

## Best Practices

1. **Use Custom Dashboards**: Create dashboards specific to your scale monitoring needs
2. **Set Up Alerts**: Configure alerts for critical metrics like disconnections and errors
3. **Monitor Trends**: Look for patterns in weight data and connection stability
4. **Correlate Events**: Use distributed tracing to understand the full request flow
5. **Regular Review**: Review error logs and metrics weekly to identify improvement areas