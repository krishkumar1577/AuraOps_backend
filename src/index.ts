import { startServer } from './app';
import { logger } from './utils/logger';

logger.info('🚀 AuraOps Backend - MVP Phase 1');
logger.info('Starting server...');

startServer().catch(error => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
