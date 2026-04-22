import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // API
  node_env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  api_url: process.env.API_URL || 'http://localhost:3000',

  // JWT
  jwt_secret: process.env.JWT_SECRET || 'your-secret-key-here',

  // MongoDB
  mongodb_uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  mongodb_db: process.env.MONGODB_DB || 'auraops',

  // Redis
  redis_url: process.env.REDIS_URL || 'redis://localhost:6379',

  // AWS S3
  aws_region: process.env.AWS_REGION || 'us-east-1',
  aws_access_key_id: process.env.AWS_ACCESS_KEY_ID || '',
  aws_secret_access_key: process.env.AWS_SECRET_ACCESS_KEY || '',
  s3_bucket: process.env.S3_BUCKET || 'aura-weights',

  // Lambda Labs
  lambda_labs_api_key: process.env.LAMBDA_LABS_API_KEY || '',

  // Logging
  log_level: process.env.LOG_LEVEL || 'info',

  // Warm Worker Pool
  min_warm_workers: parseInt(process.env.MIN_WARM_WORKERS || '2', 10),
  max_idle_ms: parseInt(process.env.MAX_IDLE_MS || '3600000', 10),

  // Validation
  isDev: process.env.NODE_ENV === 'development',
  isProd: process.env.NODE_ENV === 'production',
};

export default config;
