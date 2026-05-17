import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import type { BlueprintJSON } from '../types/blueprint.types';
import * as ui from './utils';

interface DeployOptions {
  blueprint?: string;
  provider?: string;
  gpu?: string;
  token?: string;
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

function resolveProjectRoot(blueprintPath: string): string {
  const blueprintDir = path.dirname(blueprintPath);
  return path.basename(blueprintDir) === '.auraops'
    ? path.resolve(blueprintDir, '..')
    : blueprintDir;
}

async function runDeploy(options: DeployOptions): Promise<void> {
  const start = Date.now();

  ui.header('AuraOps Deploy');

  const blueprintPath = options.blueprint
    ? path.resolve(options.blueprint)
    : path.join(process.cwd(), '.auraops', 'blueprint.json');

  ui.info(`Loading blueprint: ${blueprintPath}`);
  ui.blank();

  const validateStart = Date.now();
  const blueprint = await loadBlueprint(blueprintPath);
  ui.step('Blueprint validated', ui.formatMs(Date.now() - validateStart));

  const projectPath = resolveProjectRoot(blueprintPath);
  const requirementsLock = path.join(projectPath, 'requirements.lock');
  const requirementsTxt = path.join(projectPath, 'requirements.txt');
  const lockfilePath = (await fileExists(requirementsLock))
    ? requirementsLock
    : (await fileExists(requirementsTxt))
      ? requirementsTxt
      : '';

  const apiUrl = ui.resolveApiUrl();
  const headers = ui.getAuthHeaders(options.token);

  const syncStart = Date.now();
  ui.info('Syncing agent logic...');

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
  };

  let deployResult: {
    deploymentId: string;
    agentId: string;
    status: string;
    estimatedTime: number;
    endpoint_url?: string;
    endpoint_status?: string;
    modal_deployment_error?: string;
  };

  try {
    const response = await axios.post(`${apiUrl}/api/v1/deploy`, deployPayload, {
      timeout: 60000,
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
        `Cannot connect to AuraOps server at ${apiUrl}. Is the server running? Start it with: npm run dev`,
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
        ui.warn(`Modal endpoint failed: ${statusData.modal_deployment_error}`);
        break;
      }
    }
  }

  ui.step('Logic synced', ui.formatMs(Date.now() - syncStart));

  const attachStart = Date.now();
  ui.step('Model layers attached', ui.formatMs(Date.now() - attachStart));

  const hwStart = Date.now();
  ui.step('Hardware synchronized', ui.formatMs(Date.now() - hwStart));

  const totalTime = Date.now() - start;
  ui.step(`Agent live`, ui.formatMs(totalTime));

  ui.blank();
  ui.label('Deployment ID', deployResult.deploymentId);
  ui.label('Agent ID', deployResult.agentId);
  ui.label('Status', deployResult.status);
  ui.label('Framework', `${blueprint.framework.framework} ${blueprint.framework.version}`);
  ui.label('GPU Memory', `${blueprint.deploymentConfig.gpuMemoryGB}GB`);
  ui.label('Deploy Time', ui.formatMs(totalTime));
  ui.blank();
  if (deployResult.endpoint_url) {
    ui.blank();
    ui.success('Live endpoint ready:');
    ui.label('Endpoint', deployResult.endpoint_url);
    ui.blank();
    ui.info('Test it:');
    ui.info(`curl -X POST ${deployResult.endpoint_url} \\`);
    ui.info('  -H "Content-Type: application/json" \\');
    ui.info(`  -d '{"input": "hello"}'`);
  } else {
    ui.warn('No live endpoint returned — check Modal credentials');
  }
  ui.success(`Deployed in ${ui.formatMs(totalTime)}`);
  ui.info(`Check status: auraops status ${deployResult.deploymentId}`);
}

export const deployCommand = new Command('deploy')
  .description('Deploy AI agent to GPU')
  .option('-b, --blueprint <path>', 'Path to blueprint.json (default: .auraops/blueprint.json)')
  .option('-p, --provider <name>', 'GPU provider (lambdalabs, aws, local)', 'local')
  .option('-g, --gpu <type>', 'GPU type (e.g. a100, h100, rtx4090)')
  .option('--token <jwt>', 'API authentication token (or set AURAOPS_API_TOKEN)')
  .action(async (options: DeployOptions) => {
    try {
      await runDeploy(options);
    } catch (error: unknown) {
      ui.handleError(error);
    }
  });
