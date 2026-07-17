import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { AuraOpsError } from '../utils/errors';

/**
 * Minimal Grok-like CLI palette: muted chrome, bright white type, soft status colors.
 * Honors NO_COLOR and non-TTY (CI-friendly plain text).
 */
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // bright white / gray (readable on dark terminals)
  white: '\x1b[97m',
  muted: '\x1b[90m',
  // status
  green: '\x1b[32m',
  red: '\x1b[31m',
  amber: '\x1b[33m',
  // soft accent (not neon cyan spam)
  accent: '\x1b[36m',
};

/** @deprecated internal alias for older references */
const COLORS = {
  reset: C.reset,
  bold: C.bold,
  dim: C.dim,
  red: C.red,
  green: C.green,
  yellow: C.amber,
  blue: '\x1b[34m',
  cyan: C.accent,
  white: C.white,
};

function colorEnabled(): boolean {
  if (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true') {
    return false;
  }
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function paint(codes: string, text: string): string {
  if (!colorEnabled()) {
    return text;
  }
  return `${codes}${text}${C.reset}`;
}

function mark(symbol: string, code: string): string {
  return paint(code, symbol);
}

/** True when stdin/stdout are TTYs and CI is not set — safe to prompt interactively. */
export function isInteractive(): boolean {
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return false;
  }
  if (process.env.AURAOPS_NONINTERACTIVE === '1' || process.env.AURAOPS_NONINTERACTIVE === 'true') {
    return false;
  }
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prompt the user for a single line. When `secret` is true, echo is masked with *.
 * Rejects (via empty string) if the user submits blank input.
 */
export function promptLine(question: string, options?: { secret?: boolean }): Promise<string> {
  const secret = options?.secret ?? false;

  const styled =
    question.includes('›') || question.startsWith(' ')
      ? question
      : paint(C.muted, '› ') + question;

  if (!secret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(styled, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // Masked input without extra dependencies
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(styled);

    if (typeof stdin.setRawMode !== 'function') {
      // Fallback: visible prompt
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk: string | Buffer) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\n' || ch === '\r') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        // Ignore other control chars
        if (ch < ' ') {
          continue;
        }
        value += ch;
        stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const q = paint(C.muted, '› ') + question + paint(C.muted, ` (${hint}) `);
  const answer = await promptLine(q);
  if (!answer) {
    return defaultYes;
  }
  return /^(y|yes)$/i.test(answer);
}

/**
 * Upsert KEY=value lines into a local .env file (creates if missing).
 * Does not print secret values.
 */
export async function upsertEnvFile(
  envPath: string,
  entries: Record<string, string>,
): Promise<void> {
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf-8');
  } catch {
    content = '';
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const keys = new Set(Object.keys(entries));
  const next: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && keys.has(match[1])) {
      continue; // drop old assignment; rewrite below
    }
    next.push(line);
  }

  // Trim trailing empty lines before append
  while (next.length > 0 && next[next.length - 1] === '') {
    next.pop();
  }

  for (const [key, value] of Object.entries(entries)) {
    const escaped = value.includes('\n') || value.includes('"') || value.includes(' ')
      ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : value;
    next.push(`${key}=${escaped}`);
  }
  next.push('');

  await fs.writeFile(envPath, next.join('\n'), 'utf-8');
}

export interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
}

/**
 * Resolve Modal tokens from env/config, or interactively prompt when missing.
 * Sets process.env so child `modal` CLI inherits credentials.
 */
export async function ensureModalCredentials(options?: {
  tokenId?: string;
  tokenSecret?: string;
  /** When true (default), offer to save into ./.env after a successful prompt. */
  offerSave?: boolean;
}): Promise<ModalCredentials> {
  let tokenId =
    options?.tokenId ||
    process.env.MODAL_TOKEN_ID ||
    '';
  let tokenSecret =
    options?.tokenSecret ||
    process.env.MODAL_TOKEN_SECRET ||
    '';

  // Lazy-read config defaults without circular import at module load in tests
  if (!tokenId || !tokenSecret) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../utils/config') as {
        config: { modal_token_id?: string; modal_token_secret?: string };
      };
      tokenId = tokenId || config.modal_token_id || '';
      tokenSecret = tokenSecret || config.modal_token_secret || '';
    } catch {
      // config may throw in misconfigured envs; continue with prompt path
    }
  }

  if (tokenId && tokenSecret) {
    process.env.MODAL_TOKEN_ID = tokenId;
    process.env.MODAL_TOKEN_SECRET = tokenSecret;
    return { tokenId, tokenSecret };
  }

  if (!isInteractive()) {
    throw new AuraOpsError(
      'MISSING_CREDENTIALS',
      'Modal credentials required. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET ' +
        '(environment or .env), or re-run in an interactive terminal to enter them.',
      401,
    );
  }

  warn('Modal credentials not found.');
  info('Get tokens at: https://modal.com/settings (Token ID + Token Secret)');
  blank();

  if (!tokenId) {
    tokenId = await promptLine('Modal Token ID: ');
  }
  if (!tokenSecret) {
    tokenSecret = await promptLine('Modal Token Secret: ', { secret: true });
  }

  if (!tokenId || !tokenSecret) {
    throw new AuraOpsError(
      'MISSING_CREDENTIALS',
      'Modal Token ID and Token Secret are both required to deploy.',
      401,
    );
  }

  process.env.MODAL_TOKEN_ID = tokenId;
  process.env.MODAL_TOKEN_SECRET = tokenSecret;
  success('Modal credentials set for this session.');

  if (options?.offerSave !== false) {
    try {
      const save = await promptYesNo('Save MODAL_TOKEN_ID / MODAL_TOKEN_SECRET to ./.env for next time?', false);
      if (save) {
        const envPath = path.resolve(process.cwd(), '.env');
        await upsertEnvFile(envPath, {
          MODAL_TOKEN_ID: tokenId,
          MODAL_TOKEN_SECRET: tokenSecret,
        });
        success(`Saved to ${envPath}`);
      }
    } catch {
      // Ignore save failures; session env is enough to continue
    }
  }

  return { tokenId, tokenSecret };
}

/**
 * Resolve AuraOps API JWT from flag/env, or prompt when missing (server CLI commands).
 */
export async function ensureApiToken(token?: string, options?: { offerSave?: boolean }): Promise<string> {
  let resolved =
    token ||
    process.env.AURAOPS_API_TOKEN ||
    process.env.AURAOPS_TOKEN ||
    '';

  if (resolved) {
    process.env.AURAOPS_API_TOKEN = resolved;
    return resolved;
  }

  if (!isInteractive()) {
    throw new AuraOpsError(
      'MISSING_CREDENTIALS',
      'API token required. Pass --token, set AURAOPS_API_TOKEN, or re-run in an interactive terminal to enter it.',
      401,
    );
  }

  warn('AuraOps API token not found.');
  info('Log in via the dashboard or POST /api/v1/auth/login, then paste the JWT here.');
  blank();

  resolved = await promptLine('AuraOps API token (JWT): ', { secret: true });
  if (!resolved) {
    throw new AuraOpsError(
      'MISSING_CREDENTIALS',
      'API token is required for this command.',
      401,
    );
  }

  process.env.AURAOPS_API_TOKEN = resolved;
  success('API token set for this session.');

  if (options?.offerSave !== false) {
    try {
      const save = await promptYesNo('Save AURAOPS_API_TOKEN to ./.env for next time?', false);
      if (save) {
        const envPath = path.resolve(process.cwd(), '.env');
        await upsertEnvFile(envPath, { AURAOPS_API_TOKEN: resolved });
        success(`Saved to ${envPath}`);
      }
    } catch {
      // ignore
    }
  }

  return resolved;
}

/** Compact brand line for help / major commands. */
export function brand(version?: string): void {
  const name = paint(C.bold + C.white, 'auraops');
  const tag = paint(C.muted, version ? `  v${version}` : '');
  const tagline = paint(C.muted, '  deploy agents · gpu');
  process.stdout.write(`\n  ${name}${tag}\n`);
  process.stdout.write(`${tagline}\n`);
  divider();
}

/** Thin horizontal rule (muted). */
export function divider(width = 36): void {
  const line = '─'.repeat(Math.max(12, Math.min(width, 56)));
  process.stdout.write(`  ${paint(C.muted, line)}\n`);
}

export function success(message: string): void {
  process.stdout.write(`  ${mark('✓', C.green)}  ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`  ${mark('✗', C.red)}  ${message}\n`);
}

export function info(message: string): void {
  process.stdout.write(`  ${mark('·', C.muted)}  ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`  ${mark('!', C.amber)}  ${message}\n`);
}

export function step(message: string, timing?: string): void {
  const suffix = timing ? paint(C.muted, `  ${timing}`) : '';
  process.stdout.write(`  ${mark('✓', C.green)}  ${message}${suffix}\n`);
}

/**
 * Command title block — clean, not loud.
 * Example:
 *   init
 *   ────
 */
export function header(title: string): void {
  const clean = title.replace(/^AuraOps\s+/i, '').trim() || title;
  process.stdout.write('\n');
  process.stdout.write(`  ${paint(C.bold + C.white, clean)}\n`);
  divider(Math.min(40, Math.max(16, clean.length + 4)));
}

export function label(key: string, value: string): void {
  const k = paint(C.muted, key.padEnd(14));
  process.stdout.write(`  ${k}  ${paint(C.white, value)}\n`);
}

/** Key facts after a successful run. */
export function summary(rows: Array<[string, string]>): void {
  blank();
  process.stdout.write(`  ${paint(C.dim, 'summary')}\n`);
  for (const [key, value] of rows) {
    label(key, value);
  }
}

export function blank(): void {
  process.stdout.write('\n');
}

/** Done line with optional total time. */
export function done(message = 'done', timing?: string): void {
  blank();
  const t = timing ? paint(C.muted, `  ·  ${timing}`) : '';
  process.stdout.write(`  ${mark('✓', C.green)}  ${paint(C.bold, message)}${t}\n`);
  blank();
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

/** Sync header helper when token is already known. Prefer `resolveAuthHeaders` for CLI commands. */
export function getAuthHeaders(token?: string): Record<string, string> {
  const resolved = token || process.env.AURAOPS_API_TOKEN || process.env.AURAOPS_TOKEN || '';
  if (!resolved) {
    warn(
      'No API token provided. Set AURAOPS_API_TOKEN or pass --token. Server will reject requests.',
    );
    return {};
  }
  return { Authorization: `Bearer ${resolved}` };
}

/** Resolve API token (prompt if needed) and return Authorization headers. */
export async function resolveAuthHeaders(token?: string): Promise<Record<string, string>> {
  const resolved = await ensureApiToken(token);
  return { Authorization: `Bearer ${resolved}` };
}

/** Production API (Render). Override with AURAOPS_API_URL. */
const DEFAULT_API_URL = 'https://auraops-backend-s2gw.onrender.com';

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
