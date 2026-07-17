import { Command, type OptionValueSource } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import type { BlueprintJSON } from '../types/blueprint.types';
import { resolveProjectRoot } from '../services/orchestration/userProjectDeploy';
import { packProjectBundle } from '../services/orchestration/projectBundle';
import * as ui from './utils';
import { runFleetDeploy } from './fleet';
import { runLocalDeploy } from './localDeploy';

interface DeployOptions {
  blueprint?: string;
  provider?: string;
  gpu?: string;
  gpus?: string;
  token?: string;
  fleet?: string;
  mcp?: boolean;
  server?: boolean;
}

function parseGpuCount(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new Error('GPU count must be an integer between 1 and 8');
  }
  return count;
}

async function loadBlueprint(blueprintPath: string): Promise<BlueprintJSON> {
  try {
    const content = await fs.readFile(blueprintPath, 'utf-8');
    return JSON.parse(content) as BlueprintJSON;
  } catch {
    throw new Error(`Failed to load blueprint: ${blueprintPath}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function printDeploySummary(options: {
  deploymentId: string;
  agentId?: string;
  status: string;
  blueprint: BlueprintJSON;
  gpuCount: number;
  totalTimeMs: number;
  endpointUrl?: string;
  mcp?: boolean;
  mcpEnabled?: boolean;
  claudeDesktopConfigJson?: string;
  apiUrl?: string;
  mode: 'local' | 'server';
}): void {
  ui.blank();
  ui.label('Deployment ID', options.deploymentId);
  if (options.agentId) {
    ui.label('Agent ID', options.agentId);
  }
  ui.label('Status', options.status);
  ui.label('Mode', options.mode === 'local' ? 'local (Modal CLI)' : 'hosted server');
  ui.label('Framework', `${options.blueprint.framework.framework} ${options.blueprint.framework.version}`);
  ui.label('GPU Memory', `${options.blueprint.deploymentConfig.gpuMemoryGB}GB`);
  ui.label('GPUs', String(options.gpuCount));
  ui.label('Deploy Time', ui.formatMs(options.totalTimeMs));
  ui.blank();

  if (options.endpointUrl) {
    ui.success('Live endpoint ready:');
    ui.label('Endpoint', options.endpointUrl);
    ui.blank();
    ui.info('Test it:');
    ui.info(`curl -X POST ${options.endpointUrl} \\`);
    ui.info('  -H "Content-Type: application/json" \\');
    ui.info(`  -d '{"input": "hello"}'`);

    if (options.mcp && options.mcpEnabled) {
      ui.blank();
      ui.success('MCP server ready — add to Claude Desktop:');
      ui.info('~/Library/Application Support/Claude/claude_desktop_config.json');
      ui.blank();
      if (options.claudeDesktopConfigJson) {
        process.stdout.write(options.claudeDesktopConfigJson + '\n');
      }
      if (options.mode === 'server' && options.apiUrl) {
        ui.blank();
        ui.info(`MCP card: GET ${options.apiUrl}/api/v1/deployment/${options.deploymentId}/mcp/card`);
        ui.info(`Discovery: GET ${options.apiUrl}/.well-known/mcp/${options.deploymentId}.json`);
      }
    }
  } else {
    ui.warn('No live endpoint returned — check Modal credentials');
  }

  ui.done('deployed', ui.formatMs(options.totalTimeMs));
  if (options.mode === 'server') {
    ui.info(`status → auraops status ${options.deploymentId}`);
  } else {
    ui.info('saved → .auraops/last-deployment.json');
  }
}

async function runLocalDeployFlow(
  options: DeployOptions,
  blueprint: BlueprintJSON,
  blueprintPath: string,
  gpuCount: number,
  start: number,
): Promise<void> {
  if (options.provider && !['auto', 'modal'].includes(options.provider)) {
    ui.warn(
      `Provider "${options.provider}" is only supported with --server. Using local Modal deploy.`,
    );
  }

  const genStart = Date.now();
  const result = await runLocalDeploy({
    blueprint,
    blueprintPath,
    gpuCount,
    enableMcp: options.mcp ?? false,
  });
  ui.step('Modal app deployed locally', ui.formatMs(Date.now() - genStart));

  const totalTime = Date.now() - start;
  ui.step('Agent live', ui.formatMs(totalTime));

  printDeploySummary({
    deploymentId: result.deploymentId,
    status: 'running',
    blueprint,
    gpuCount,
    totalTimeMs: totalTime,
    endpointUrl: result.endpointUrl,
    mcp: options.mcp,
    mcpEnabled: result.mcpEnabled,
    claudeDesktopConfigJson: result.claudeDesktopConfigJson,
    mode: 'local',
  });
}

async function runServerDeploy(
  options: DeployOptions,
  blueprint: BlueprintJSON,
  blueprintPath: string,
  gpuCount: number,
  start: number,
): Promise<void> {
  const provider = (options.provider ?? 'auto').toLowerCase();
  if (provider === 'azure' || provider === 'aws') {
    ui.warn(
      `Provider "${options.provider}" is partial — full user-code deploy path is Modal-first. Azure/AWS may not run agent code end-to-end yet.`,
    );
  }

  const projectPath = resolveProjectRoot(blueprintPath);
  const requirementsLock = path.join(projectPath, 'requirements.lock');
  const requirementsTxt = path.join(projectPath, 'requirements.txt');
  const lockfilePath = (await fileExists(requirementsLock))
    ? requirementsLock
    : (await fileExists(requirementsTxt))
      ? requirementsTxt
      : '';

  const apiUrl = ui.resolveApiUrl();
  const headers = await ui.resolveAuthHeaders(options.token);

  const syncStart = Date.now();
  ui.info('Syncing agent logic to AuraOps server...');

  let bundle: Awaited<ReturnType<typeof packProjectBundle>>;
  try {
    bundle = await packProjectBundle(projectPath);
  } catch (err) {
    ui.warn(
      'Project pack failed. Large weight/model files are auto-skipped; host weights on S3 or Hugging Face and list them in blueprint customModels.',
    );
    const msg = err instanceof Error ? err.message : String(err);
    ui.fail(msg);
    throw err;
  }

  const skipNote =
    bundle.skippedFiles > 0
      ? `; skipped ${bundle.skippedFiles} large/weight files (${bundle.skippedBytes} bytes)`
      : '';
  ui.info(
    `Packed project bundle: ${bundle.fileCount} files (${bundle.uncompressedBytes} bytes)${skipNote}`,
  );

  const deployPayload = {
    blueprintId: blueprint.id,
    blueprintJson: blueprint,
    lockfilePath,
    environmentHash: blueprint.checksums?.allDepsHash ?? blueprint.id ?? 'no-hash',
    gpuRequirements: {
      minMemory: blueprint.deploymentConfig.gpuMemoryGB,
      framework: blueprint.framework.framework,
      pythonVersion: blueprint.framework.pythonVersion,
    },
    gpuCount,
    enableMcp: options.mcp ?? false,
    provider: options.provider && options.provider !== 'local' ? options.provider : 'auto',
    projectBundleBase64: bundle.projectBundleBase64,
    projectBundleFormat: bundle.projectBundleFormat,
  };

  let deployResult: {
    deploymentId: string;
    agentId: string;
    status: string;
    estimatedTime: number;
    endpoint_url?: string;
    endpoint_status?: string;
    modal_deployment_error?: string;
    mcp_enabled?: boolean;
    mcp_card?: Record<string, unknown>;
    claude_desktop_config_json?: string;
  };

  try {
    const response = await axios.post(`${apiUrl}/api/v1/deploy`, deployPayload, {
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers,
    });
    deployResult = response.data as typeof deployResult;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      const data = error.response.data as Record<string, unknown>;
      const msg = typeof data.error === 'string' ? data.error : 'Deployment request failed';
      throw new Error(msg);
    }
    if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
      throw new Error(
        `Cannot connect to AuraOps server at ${apiUrl}. Use local deploy (default) or start the server with: npm run dev`,
      );
    }
    throw error;
  }

  if (!deployResult.endpoint_url) {
    ui.info('Waiting for live endpoint...');

    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const statusRes = await axios.get(
        `${apiUrl}/api/v1/deployment/${deployResult.deploymentId}`,
        { headers },
      );
      const statusData = statusRes.data as {
        endpointUrl?: string;
        endpoint_url?: string;
        endpoint_status?: string;
        modal_deployment_error?: string;
      };

      if (statusData.endpointUrl || statusData.endpoint_url) {
        deployResult.endpoint_url = statusData.endpointUrl ?? statusData.endpoint_url;
        break;
      }

      if (statusData.endpoint_status === 'failed') {
        ui.warn(`Endpoint failed: ${statusData.modal_deployment_error}`);
        break;
      }
    }
  }

  ui.step('Logic synced', ui.formatMs(Date.now() - syncStart));

  const totalTime = Date.now() - start;
  ui.step('Agent live', ui.formatMs(totalTime));

  printDeploySummary({
    deploymentId: deployResult.deploymentId,
    agentId: deployResult.agentId,
    status: deployResult.status,
    blueprint,
    gpuCount,
    totalTimeMs: totalTime,
    endpointUrl: deployResult.endpoint_url,
    mcp: options.mcp,
    mcpEnabled: deployResult.mcp_enabled,
    claudeDesktopConfigJson: deployResult.claude_desktop_config_json,
    apiUrl,
    mode: 'server',
  });
}

async function runDeploy(options: DeployOptions, gpusSource?: OptionValueSource): Promise<void> {
  const start = Date.now();

  ui.header('deploy');

  const blueprintPath = options.blueprint
    ? path.resolve(options.blueprint)
    : path.join(process.cwd(), '.auraops', 'blueprint.json');

  ui.info(`Loading blueprint: ${blueprintPath}`);
  ui.blank();

  const validateStart = Date.now();
  const blueprint = await loadBlueprint(blueprintPath);
  ui.step('Blueprint validated', ui.formatMs(Date.now() - validateStart));

  const gpuCount = gpusSource === 'cli' ? parseGpuCount(options.gpus) : 1;

  if (options.server) {
    await runServerDeploy(options, blueprint, blueprintPath, gpuCount, start);
    return;
  }

  await runLocalDeployFlow(options, blueprint, blueprintPath, gpuCount, start);
}

export const deployCommand = new Command('deploy')
  .description('Deploy AI agent to GPU (local Modal CLI by default)')
  .option('-b, --blueprint <path>', 'Path to blueprint.json (default: .auraops/blueprint.json)')
  .option('-p, --provider <name>', 'GPU provider for hosted deploy (auto, modal, azure, aws)', 'auto')
  .option('-g, --gpu <type>', 'GPU type (e.g. a100, h100, rtx4090)')
  .option('--gpus <count>', 'Number of GPUs to allocate (1-8)')
  .option('--token <jwt>', 'API authentication token for hosted deploy (or set AURAOPS_API_TOKEN)')
  .option('--server', 'Deploy via hosted AuraOps backend instead of local Modal CLI')
  .option('--fleet <path>', 'Deploy a multi-agent crew from crew.yaml')
  .option('--mcp', 'Auto-generate MCP server endpoint on deploy')
  .action(async (options: DeployOptions, command: Command) => {
    try {
      if (options.fleet) {
        await runFleetDeploy({
          fleet: options.fleet,
          token: options.token,
          gpus: options.gpus,
        });
        return;
      }
      await runDeploy(options, command.getOptionValueSource('gpus'));
    } catch (error: unknown) {
      ui.handleError(error);
    }
  });
