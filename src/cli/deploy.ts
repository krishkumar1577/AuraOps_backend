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

  const apiUrl = ui.resolveApiUrl();
  const headers = ui.getAuthHeaders(options.token);

  const syncStart = Date.now();
  ui.info('Syncing agent logic...');

  const deployPayload = {
    blueprintId: blueprint.id,
    blueprintJson: blueprint,
    lockfilePath: path.join(path.dirname(blueprintPath), 'requirements.lock'),
    environmentHash: blueprint.checksums.allDepsHash,
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
