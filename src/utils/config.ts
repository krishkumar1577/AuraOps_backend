import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_URL: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017'),
  MONGODB_DB: z.string().min(1).default('auraops'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET: z.string().min(1).default('aura-weights'),
  LAMBDA_LABS_API_KEY: z.string().default(''),
  MODAL_TOKEN_ID: z.string().default(''),
  MODAL_TOKEN_SECRET: z.string().default(''),
  // Cold modal deploy (pip + image build) often exceeds 2 min; default 10 min
  MODAL_DEPLOY_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(1_800_000).default(600_000),
  CORS_ORIGIN: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  MIN_WARM_WORKERS: z.coerce.number().int().nonnegative().default(2),
  MAX_IDLE_MS: z.coerce.number().int().positive().default(3600000),
  // 32MB default so server deploy can accept project bundles (~15MB uncompressed + base64 overhead)
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().positive().default(33554432),
  AWS_ENDPOINT_URL: z.string().optional(),
  AZURE_SUBSCRIPTION_ID: z.string().default(''),
  AZURE_TENANT_ID: z.string().default(''),
  AZURE_CLIENT_ID: z.string().default(''),
  AZURE_CLIENT_SECRET: z.string().default(''),
  AZURE_RESOURCE_GROUP: z.string().default('auraops-rg'),
  AZURE_LOCATION: z.string().default('eastus'),
  AZURE_STORAGE_ACCOUNT: z.string().default(''),
  AZURE_STORAGE_CONTAINER: z.string().default('aura-weights'),
  LOOPS_API_KEY: z.string().default(''),
  /** Razorpay (India) — pay-as-you-go credits for hosted deploys */
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  /**
   * If false, hosted deploys are blocked when user has 0 credits.
   * Set true only for emergency owner testing (still requires auth).
   */
  BILLING_ENFORCE: z
    .enum(['true', 'false', '1', '0', ''])
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
});

const env = EnvSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  API_URL: process.env.API_URL,
  JWT_SECRET: process.env.JWT_SECRET ?? 'change-me-in-development-only',
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DB: process.env.MONGODB_DB,
  REDIS_URL: process.env.REDIS_URL,
  AWS_REGION: process.env.AWS_REGION,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  S3_BUCKET: process.env.S3_BUCKET,
  LAMBDA_LABS_API_KEY: process.env.LAMBDA_LABS_API_KEY,
  MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID,
  MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET,
  MODAL_DEPLOY_TIMEOUT_MS: process.env.MODAL_DEPLOY_TIMEOUT_MS,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  LOG_LEVEL: process.env.LOG_LEVEL,
  MIN_WARM_WORKERS: process.env.MIN_WARM_WORKERS,
  MAX_IDLE_MS: process.env.MAX_IDLE_MS,
  MAX_REQUEST_BODY_BYTES: process.env.MAX_REQUEST_BODY_BYTES,
  AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
  LOOPS_API_KEY: process.env.LOOPS_API_KEY,
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  BILLING_ENFORCE: process.env.BILLING_ENFORCE,
  AZURE_SUBSCRIPTION_ID: process.env.AZURE_SUBSCRIPTION_ID,
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID,
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
  AZURE_RESOURCE_GROUP: process.env.AZURE_RESOURCE_GROUP,
  AZURE_LOCATION: process.env.AZURE_LOCATION,
  AZURE_STORAGE_ACCOUNT: process.env.AZURE_STORAGE_ACCOUNT,
  AZURE_STORAGE_CONTAINER: process.env.AZURE_STORAGE_CONTAINER,
});

if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'change-me-in-development-only') {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  node_env: env.NODE_ENV,
  port: env.PORT,
  api_url: env.API_URL,
  jwt_secret: env.JWT_SECRET,
  mongodb_uri: env.MONGODB_URI,
  mongodb_db: env.MONGODB_DB,
  redis_url: env.REDIS_URL,
  aws_region: env.AWS_REGION,
  aws_access_key_id: env.AWS_ACCESS_KEY_ID,
  aws_secret_access_key: env.AWS_SECRET_ACCESS_KEY,
  s3_bucket: env.S3_BUCKET,
  lambda_labs_api_key: env.LAMBDA_LABS_API_KEY,
  modal_token_id: env.MODAL_TOKEN_ID,
  modal_token_secret: env.MODAL_TOKEN_SECRET,
  modal_deploy_timeout_ms: env.MODAL_DEPLOY_TIMEOUT_MS,
  cors_origin: env.CORS_ORIGIN,
  log_level: env.LOG_LEVEL,
  min_warm_workers: env.MIN_WARM_WORKERS,
  max_idle_ms: env.MAX_IDLE_MS,
  max_request_body_bytes: env.MAX_REQUEST_BODY_BYTES,
  isDev: env.NODE_ENV === 'development',
  isProd: env.NODE_ENV === 'production',
  aws_endpoint_url: env.AWS_ENDPOINT_URL,
  loops_api_key: env.LOOPS_API_KEY,
  razorpay_key_id: env.RAZORPAY_KEY_ID,
  razorpay_key_secret: env.RAZORPAY_KEY_SECRET,
  billing_enforce: env.BILLING_ENFORCE,
  azure_subscription_id: env.AZURE_SUBSCRIPTION_ID,
  azure_tenant_id: env.AZURE_TENANT_ID,
  azure_client_id: env.AZURE_CLIENT_ID,
  azure_client_secret: env.AZURE_CLIENT_SECRET,
  azure_resource_group: env.AZURE_RESOURCE_GROUP,
  azure_location: env.AZURE_LOCATION,
  azure_storage_account: env.AZURE_STORAGE_ACCOUNT,
  azure_storage_container: env.AZURE_STORAGE_CONTAINER,
};

export default config;
