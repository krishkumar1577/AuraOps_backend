import { AuraOpsError } from '../utils/errors';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

export function success(message: string): void {
  process.stdout.write(`${COLORS.green}✓${COLORS.reset} ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${COLORS.red}✗${COLORS.reset} ${message}\n`);
}

export function info(message: string): void {
  process.stdout.write(`${COLORS.cyan}ℹ${COLORS.reset} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${COLORS.yellow}⚠${COLORS.reset} ${message}\n`);
}

export function step(message: string, timing?: string): void {
  const suffix = timing ? ` ${COLORS.dim}[${timing}]${COLORS.reset}` : '';
  process.stdout.write(`${COLORS.green}✓${COLORS.reset} ${message}${suffix}\n`);
}

export function header(title: string): void {
  process.stdout.write(`\n${COLORS.bold}${COLORS.cyan}${title}${COLORS.reset}\n`);
}

export function label(key: string, value: string): void {
  process.stdout.write(`  ${COLORS.dim}${key}:${COLORS.reset} ${value}\n`);
}

export function blank(): void {
  process.stdout.write('\n');
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function getAuthHeaders(token?: string): Record<string, string> {
  const resolved = token || process.env.AURAOPS_API_TOKEN || '';
  if (!resolved) {
    warn(
      'No API token provided. Set AURAOPS_API_TOKEN or pass --token. Server will reject requests.',
    );
    return {};
  }
  return { Authorization: `Bearer ${resolved}` };
}

const DEFAULT_API_URL = 'https://auraops-backend-production.up.railway.app';

export function resolveApiUrl(): string {
  return process.env.AURAOPS_API_URL || DEFAULT_API_URL;
}

export function handleError(error: unknown): never {
  if (error instanceof AuraOpsError) {
    fail(error.message);

    if (error.details) {
      const detailEntries = Object.entries(error.details).filter(
        ([key]) => key !== 'cause',
      );
      if (detailEntries.length > 0) {
        process.stderr.write(`\n${COLORS.dim}Details:${COLORS.reset}\n`);
        for (const [key, value] of detailEntries) {
          process.stderr.write(`  ${key}: ${String(value)}\n`);
        }
      }

      if (error.details.cause) {
        process.stderr.write(
          `\n${COLORS.dim}Cause: ${String(error.details.cause)}${COLORS.reset}\n`,
        );
      }
    }

    process.exit(1);
  }

  if (error instanceof Error) {
    fail(error.message);
    process.exit(1);
  }

  fail(String(error));
  process.exit(1);
}
