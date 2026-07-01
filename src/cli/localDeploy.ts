import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { BlueprintJSON } from '../types/blueprint.types';
import { ModalAppDeployer } from '../services/orchestration/modalAppDeployer';
import {
  generateClaudeDesktopConfig,
  serializeClaudeDesktopConfig,
} from '../services/mcp/mcpCardGenerator';
import { DeploymentError } from '../utils/errors';
import { config } from '../utils/config';
import * as ui from './utils';

export interface LocalDeployOptions {
  blueprint: BlueprintJSON;
  blueprintPath: string;
  gpuCount: number;
  enableMcp?: boolean;
}

export interface LocalDeployResult {
  deploymentId: string;
  endpointUrl: string;
  deployTimeMs: number;
  mcpEnabled: boolean;
  claudeDesktopConfigJson?: string;
}

function resolveModalTokens(): { tokenId: string; tokenSecret: string } {
  const tokenId = process.env.MODAL_TOKEN_ID || config.modal_token_id;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET || config.modal_token_secret;

  if (!tokenId || !tokenSecret) {
    throw new DeploymentError(
      'Modal credentials required for local deploy. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in your environment or .env file.',
    );
  }

  return { tokenId, tokenSecret };
}

function resolveAuraopsDir(blueprintPath: string): string {
  const dir = path.dirname(blueprintPath);
  if (path.basename(dir) === '.auraops') {
    return dir;
  }
  return path.join(dir, '.auraops');
}

async function saveLocalDeploymentRecord(
  blueprintPath: string,
  record: LocalDeployResult & { framework: string },
): Promise<void> {
  const auraopsDir = resolveAuraopsDir(blueprintPath);
  await fs.mkdir(auraopsDir, { recursive: true });

  const recordPath = path.join(auraopsDir, 'last-deployment.json');
  await fs.writeFile(
    recordPath,
    JSON.stringify(
      {
        deploymentId: record.deploymentId,
        endpointUrl: record.endpointUrl,
        framework: record.framework,
        deployTimeMs: record.deployTimeMs,
        mcpEnabled: record.mcpEnabled,
        mode: 'local',
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

export async function runLocalDeploy(options: LocalDeployOptions): Promise<LocalDeployResult> {
  const start = Date.now();
  resolveModalTokens();

  const deploymentId = uuidv4();
  const { blueprint, blueprintPath, gpuCount, enableMcp } = options;

  ui.info('Generating Modal app from blueprint...');
  const appContent = ModalAppDeployer.generateModalApp(blueprint, deploymentId, {
    gpuCount,
    enableMcp: enableMcp ?? false,
  });

  const appPath = await ModalAppDeployer.writeModalApp(appContent, deploymentId);
  ui.step(`Modal app written: ${appPath}`);

  ui.info('Running modal deploy (this may take 30-60s)...');
  const endpointUrl = await ModalAppDeployer.deployApp(appPath, deploymentId);

  const deployTimeMs = Date.now() - start;
  let claudeDesktopConfigJson: string | undefined;

  if (enableMcp) {
    const claudeConfig = generateClaudeDesktopConfig({
      deploymentId,
      endpointUrl,
      agentName: blueprint.framework.framework,
    });
    claudeDesktopConfigJson = serializeClaudeDesktopConfig(claudeConfig);
  }

  const result: LocalDeployResult = {
    deploymentId,
    endpointUrl,
    deployTimeMs,
    mcpEnabled: enableMcp ?? false,
    claudeDesktopConfigJson,
  };

  await saveLocalDeploymentRecord(blueprintPath, {
    ...result,
    framework: blueprint.framework.framework,
  });

  return result;
}
