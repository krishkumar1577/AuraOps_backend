import { Command } from 'commander';
import axios from 'axios';
import * as ui from './utils';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

interface LogsResponse {
  success: boolean;
  logs: LogEntry[];
  deploymentId: string;
}

function formatLogLine(entry: LogEntry): string {
  const levelColors: Record<string, string> = {
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    debug: '\x1b[2m',
  };
  const color = levelColors[entry.level] || '\x1b[0m';
  return `\x1b[2m[${entry.timestamp}]\x1b[0m ${color}${entry.level.toUpperCase().padEnd(5)}\x1b[0m ${entry.message}`;
}

async function fetchLogs(apiUrl: string, deploymentId: string, headers: Record<string, string>): Promise<LogEntry[]> {
  try {
    const response = await axios.get(
      `${apiUrl}/api/v1/deployment/${deploymentId}/logs`,
      { timeout: 10000, headers },
    );
    const data = response.data as LogsResponse;
    return data.logs || [];
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new Error(`Deployment not found: ${deploymentId}`);
    }
    if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
      throw new Error(
        `Cannot connect to AuraOps server at ${apiUrl}. Is the server running?`,
      );
    }
    throw error;
  }
}

async function runLogs(deploymentId: string, options: { follow: boolean; tail?: string; token?: string }): Promise<void> {
  const apiUrl = ui.resolveApiUrl();
  const headers = ui.getAuthHeaders(options.token);
  const tailCount = options.tail ? parseInt(options.tail, 10) : undefined;

  if (!options.follow) {
    let logs = await fetchLogs(apiUrl, deploymentId, headers);

    if (logs.length === 0) {
      ui.info(`No logs available for deployment ${deploymentId}`);
      return;
    }

    if (tailCount && tailCount > 0) {
      logs = logs.slice(-tailCount);
    }

    for (const entry of logs) {
      process.stdout.write(formatLogLine(entry) + '\n');
    }
    return;
  }

  // Follow mode: poll for new logs
  ui.info(`Following logs for deployment ${deploymentId} (Ctrl+C to stop)`);
  ui.blank();

  let lastTimestamp = '';
  const pollInterval = 2000;

  const poll = async (): Promise<void> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const logs = await fetchLogs(apiUrl, deploymentId, headers);
        const newLogs = lastTimestamp
          ? logs.filter(l => l.timestamp > lastTimestamp)
          : logs;

        for (const entry of newLogs) {
          process.stdout.write(formatLogLine(entry) + '\n');
          lastTimestamp = entry.timestamp;
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('not found')) {
          ui.warn('Deployment ended');
          return;
        }
      }

      await new Promise<void>(resolve => setTimeout(resolve, pollInterval));
    }
  };

  process.on('SIGINT', () => {
    ui.blank();
    ui.info('Stopped following logs');
    process.exit(0);
  });

  await poll();
}

export const logsCommand = new Command('logs')
  .description('View deployment logs')
  .argument('<deploymentId>', 'Deployment ID')
  .option('-f, --follow', 'Follow log output', false)
  .option('-t, --tail <lines>', 'Number of lines to show from end')
  .option('--token <jwt>', 'API authentication token (or set AURAOPS_API_TOKEN)')
  .action(async (deploymentId: string, options: { follow: boolean; tail?: string; token?: string }) => {
    try {
      await runLogs(deploymentId, options);
    } catch (error: unknown) {
      ui.handleError(error);
    }
  });
