import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import type { BlueprintJSON } from '../types/blueprint.types';
import { CrewParser } from '../services/fleet/crewParser';
import { resolveProjectRoot } from '../services/orchestration/userProjectDeploy';
import * as ui from './utils';

export interface FleetDeployOptions {
  fleet: string;
  token?: string;
  gpus?: string;
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

function resolveBlueprintPath(
  crewDir: string,
  agentBlueprint: string | undefined,
): string {
  if (agentBlueprint) {
    return path.resolve(crewDir, agentBlueprint);
  }
  return path.join(crewDir, '.auraops', 'blueprint.json');
}

export async function runFleetDeploy(options: FleetDeployOptions): Promise<void> {
  const start = Date.now();
  const fleetPath = path.resolve(options.fleet);
  const crewDir = path.dirname(fleetPath);

  ui.header('AuraOps Fleet Deploy');

  const parser = new CrewParser();
  const crew = await parser.parse(fleetPath);

  ui.info(`Crew: ${crew.name}`);
  ui.info(`Agents: ${crew.agents.length}, Tasks: ${crew.tasks.length}`);
  ui.blank();

  const apiUrl = ui.resolveApiUrl();
  const headers = await ui.resolveAuthHeaders(options.token);
  const gpuCount = options.gpus ? Number.parseInt(options.gpus, 10) : 1;

  const deployments: Array<{ agent: string; deploymentId: string; endpoint?: string }> = [];

  for (const agent of crew.agents) {
    const blueprintPath = resolveBlueprintPath(crewDir, agent.blueprint);
    ui.info(`Deploying agent "${agent.name}" from ${blueprintPath}`);

    const blueprint = await loadBlueprint(blueprintPath);
    const projectPath = resolveProjectRoot(blueprintPath);
    const requirementsLock = path.join(projectPath, 'requirements.lock');
    const requirementsTxt = path.join(projectPath, 'requirements.txt');
    const lockfilePath = (await fileExists(requirementsLock))
      ? requirementsLock
      : (await fileExists(requirementsTxt))
        ? requirementsTxt
        : '';

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
    };

    const response = await axios.post(`${apiUrl}/api/v1/deploy`, deployPayload, {
      timeout: 60000,
      headers,
    });

    const result = response.data as {
      deploymentId: string;
      endpoint_url?: string;
    };

    deployments.push({
      agent: agent.name,
      deploymentId: result.deploymentId,
      endpoint: result.endpoint_url,
    });

    ui.step(`Agent "${agent.name}" deployed`, result.deploymentId);
  }

  ui.blank();
  ui.success(`Fleet "${crew.name}" deployed in ${ui.formatMs(Date.now() - start)}`);
  for (const dep of deployments) {
    ui.label(dep.agent, dep.deploymentId);
    if (dep.endpoint) {
      ui.label('  endpoint', dep.endpoint);
    }
  }
}

export const fleetCommand = new Command('fleet')
  .description('Deploy a multi-agent crew from crew.yaml')
  .argument('<crew-file>', 'Path to crew.yaml')
  .option('--token <jwt>', 'API authentication token (or set AURAOPS_API_TOKEN)')
  .option('--gpus <count>', 'Number of GPUs per agent (1-8)')
  .action(async (crewFile: string, options: { token?: string; gpus?: string }) => {
    try {
      await runFleetDeploy({ fleet: crewFile, token: options.token, gpus: options.gpus });
    } catch (error: unknown) {
      ui.handleError(error);
    }
  });
