import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import type { BlueprintJSON } from '../types/blueprint.types';
import { CrewParser } from '../services/fleet/crewParser';
import { mapPool } from '../services/orchestration/parallel';
import { resolveProjectRoot } from '../services/orchestration/userProjectDeploy';
import * as ui from './utils';

/** Default parallel agent deploys (bounded to avoid API/Modal rate limits). */
const DEFAULT_FLEET_CONCURRENCY = 4;

export interface FleetDeployOptions {
  fleet: string;
  token?: string;
  gpus?: string;
  /** Max agents to deploy at once (1–16). Default 4. */
  concurrency?: number;
}

export interface FleetAgentResult {
  agent: string;
  deploymentId?: string;
  endpoint?: string;
  error?: string;
  durationMs: number;
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

function parseConcurrency(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_FLEET_CONCURRENCY;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error('Fleet concurrency must be an integer between 1 and 16');
  }
  return n;
}

/**
 * Deploy every agent in a crew.yaml in parallel (bounded concurrency).
 * Wall time ≈ slowest agent / concurrency batch, not sum of sequential deploys.
 */
export async function runFleetDeploy(options: FleetDeployOptions): Promise<void> {
  const start = Date.now();
  const fleetPath = path.resolve(options.fleet);
  const crewDir = path.dirname(fleetPath);
  const concurrency = options.concurrency ?? DEFAULT_FLEET_CONCURRENCY;

  ui.header('fleet');

  const parser = new CrewParser();
  const crew = await parser.parse(fleetPath);

  ui.info(`Crew: ${crew.name}`);
  ui.info(`Agents: ${crew.agents.length}, Tasks: ${crew.tasks.length}`);
  ui.info(`Concurrency: ${concurrency} (parallel deploys)`);
  ui.blank();

  const apiUrl = ui.resolveApiUrl();
  const headers = await ui.resolveAuthHeaders(options.token);
  const gpuCount = options.gpus ? Number.parseInt(options.gpus, 10) : 1;

  const results = await mapPool(crew.agents, concurrency, async (agent) => {
    const agentStart = Date.now();
    const blueprintPath = resolveBlueprintPath(crewDir, agent.blueprint);
    ui.info(`→ Starting agent "${agent.name}" (${blueprintPath})`);

    try {
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
        // Fleet deploys can hit cold Modal builds — align with longer server timeouts
        timeout: 600000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        headers,
      });

      const result = response.data as {
        deploymentId: string;
        endpoint_url?: string;
      };

      const durationMs = Date.now() - agentStart;
      ui.step(
        `Agent "${agent.name}" live`,
        `${result.deploymentId.slice(0, 8)}… ${ui.formatMs(durationMs)}`,
      );

      return {
        agent: agent.name,
        deploymentId: result.deploymentId,
        endpoint: result.endpoint_url,
        durationMs,
      } satisfies FleetAgentResult;
    } catch (error: unknown) {
      const durationMs = Date.now() - agentStart;
      let message = error instanceof Error ? error.message : String(error);
      if (axios.isAxiosError(error) && error.response?.data) {
        const data = error.response.data as Record<string, unknown>;
        if (typeof data.error === 'string') {
          message = data.error;
        }
      }
      ui.warn(`Agent "${agent.name}" failed (${ui.formatMs(durationMs)}): ${message}`);
      return {
        agent: agent.name,
        error: message,
        durationMs,
      } satisfies FleetAgentResult;
    }
  });

  const ok = results.filter((r) => r.deploymentId && !r.error);
  const failed = results.filter((r) => r.error);

  ui.blank();
  ui.success(
    `Fleet "${crew.name}" finished in ${ui.formatMs(Date.now() - start)} ` +
      `(${ok.length} ok, ${failed.length} failed, concurrency=${concurrency})`,
  );

  for (const dep of results) {
    if (dep.deploymentId) {
      ui.label(dep.agent, dep.deploymentId);
      if (dep.endpoint) {
        ui.label('  endpoint', dep.endpoint);
      }
      ui.label('  time', ui.formatMs(dep.durationMs));
    } else {
      ui.label(dep.agent, `FAILED: ${dep.error}`);
    }
  }

  if (failed.length > 0 && ok.length === 0) {
    throw new Error(`All ${failed.length} fleet agents failed to deploy`);
  }
  if (failed.length > 0) {
    ui.warn(`${failed.length} agent(s) failed — others are live`);
  }
}

export const fleetCommand = new Command('fleet')
  .description('Deploy a multi-agent crew from crew.yaml (parallel by default)')
  .argument('<crew-file>', 'Path to crew.yaml')
  .option('--token <jwt>', 'API authentication token (or set AURAOPS_API_TOKEN)')
  .option('--gpus <count>', 'Number of GPUs per agent (1-8)')
  .option(
    '-c, --concurrency <n>',
    `Max parallel agent deploys (1-16, default ${DEFAULT_FLEET_CONCURRENCY})`,
    String(DEFAULT_FLEET_CONCURRENCY),
  )
  .action(
    async (
      crewFile: string,
      options: { token?: string; gpus?: string; concurrency?: string },
    ) => {
      try {
        await runFleetDeploy({
          fleet: crewFile,
          token: options.token,
          gpus: options.gpus,
          concurrency: parseConcurrency(options.concurrency),
        });
      } catch (error: unknown) {
        ui.handleError(error);
      }
    },
  );
