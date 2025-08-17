import 'newrelic';
import * as http from 'http';
import { ScaleManager } from './services/ScaleManager';
import { getScaleConfigs, config } from './config';
import { createLogger } from './utils/logger';
import { NewRelicMetrics } from './utils/newrelic';

const logger = createLogger('Main');

class ScaleService {
  private scaleManager: ScaleManager;
  private healthServer?: http.Server;
  private metrics = NewRelicMetrics.getInstance();

  constructor() {
    this.scaleManager = new ScaleManager();
  }

  async start(): Promise<void> {
    logger.info({ env: config.env }, 'Starting Crowbond Scales Service');

    // Initialize scales
    const scaleConfigs = getScaleConfigs();
    
    // Record startup metrics
    this.metrics.recordStartup(scaleConfigs.length);
    
    if (scaleConfigs.length === 0) {
      logger.warn('No scale IPs configured. Add scale IPs to SCALE_IPS environment variable.');
    } else {
      await this.metrics.startBackgroundTransaction('ScaleInitialization', 'Startup', async () => {
        this.metrics.addCustomAttributes({
          scaleCount: scaleConfigs.length,
          scaleIPs: scaleConfigs.map(c => c.ip).join(','),
        });
        
        await this.scaleManager.initialize(scaleConfigs);
        
        // Start streaming for all scales
        await this.scaleManager.startStreaming();
      });
    }

    // Start health check server
    this.startHealthServer();

    // Log scale statuses periodically
    this.scaleManager.on('healthCheck', (statuses) => {
      const connected = statuses.filter((s: any) => s.isConnected).length;
      const total = statuses.length;
      logger.info({ connected, total }, 'Health check completed');
    });

    this.scaleManager.on('weightUpdate', (scaleId, weightData) => {
      logger.info({ scaleId, weight: weightData.display }, 'Weight changed');
    });

    logger.info('Service started successfully');
  }

  private startHealthServer(): void {
    this.healthServer = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        const statuses = this.scaleManager.getAllScaleStatuses();
        const healthy = statuses.length > 0 && statuses.some(s => s.isConnected);
        
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          scales: statuses,
        }));
      } else if (req.url === '/metrics' && req.method === 'GET') {
        const statuses = this.scaleManager.getAllScaleStatuses();
        const metrics = {
          scales_total: statuses.length,
          scales_connected: statuses.filter(s => s.isConnected).length,
          scales_disconnected: statuses.filter(s => !s.isConnected).length,
          total_errors: statuses.reduce((sum, s) => sum + s.errorCount, 0),
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.healthServer.listen(config.servicePort, () => {
      logger.info({ port: config.servicePort }, 'Health server started');
    });
  }

  async stop(): Promise<void> {
    logger.info('Stopping service...');
    
    if (this.healthServer) {
      this.healthServer.close();
    }
    
    await this.scaleManager.shutdown();
    logger.info('Service stopped');
  }
}

// Main execution
async function main(): Promise<void> {
  const service = new ScaleService();
  
  try {
    await service.start();
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start service');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ err: error }, 'Unhandled error');
    process.exit(1);
  });
}

export { ScaleService, ScaleManager };