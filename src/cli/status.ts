import { Command } from 'commander';
import axios from 'axios';
import * as ui from './utils';

interface StatusResult {
  success: boolean;
  deploymentId: string;
  agentId: string;
  workerId: string;
  status: string;
  startTime: number;
  latency: number;
  gpuUtilization?: number;
  endpointUrl?: string;
  appName?: string;
  error?: string;
}

async function runStatus(deploymentId: string, options: { token?: string }): Promise<void> {
  const apiUrl = ui.resolveApiUrl();
  const headers = await ui.resolveAuthHeaders(options.token);

  ui.header('status');

  let result: StatusResult;
  try {
    const response = await axios.get(
      `${apiUrl}/api/v1/deployment/${deploymentId}`,
      { timeout: 10000, headers },
    );
    result = response.data as StatusResult;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new Error(`Deployment not found: ${deploymentId}`);
    }
    if (axios.isAxiosError(error) && error.response?.status === 400) {
      throw new Error(`Invalid deployment ID format: ${deploymentId}`);
    }
    if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
      throw new Error(
        `Cannot connect to AuraOps server at ${apiUrl}. Is the server running?`,
      );
    }
    throw error;
  }

  const statusColor = result.status === 'running' ? '\x1b[32m' : result.status === 'failed' ? '\x1b[31m' : '\x1b[33m';

  ui.label('Deployment', result.deploymentId);
  ui.label('Status', `${statusColor}${result.status}\x1b[0m`);
  ui.label('Agent ID', result.agentId);
  ui.label('Worker ID', result.workerId);

  if (result.endpointUrl) {
    ui.label('Endpoint URL', result.endpointUrl);
  }

  if (result.appName) {
    ui.label('App Name', result.appName);
  }

  if (result.startTime) {
    const uptime = Date.now() - result.startTime;
    ui.label('Uptime', ui.formatUptime(uptime));
    ui.label('Started', new Date(result.startTime).toLocaleString());
  }

  if (result.gpuUtilization !== undefined) {
    ui.label('GPU Utilization', `${result.gpuUtilization}%`);
  }

  if (result.latency !== undefined) {
    ui.label('API Latency', ui.formatMs(result.latency));
  }

  if (result.error) {
    ui.blank();
    ui.fail(`Error: ${result.error}`);
  }

  ui.blank();
}

export const statusCommand = new Command('status')
  .description('Check deployment status')
  .argument('<deploymentId>', 'Deployment ID to check')
  .option('--token <jwt>', 'API authentication token (or set AURAOPS_API_TOKEN)')
  .action(async (deploymentId: string, options: { token?: string }) => {
    try {
      await runStatus(deploymentId, options);
    } catch (error: unknown) {
      ui.handleError(error);
    }
  });
