import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ManifestParser } from '../services/blueprinting/manifestParser';
import { FrameworkDetector } from '../services/blueprinting/frameworkDetector';
import { BlueprintGenerator } from '../services/blueprinting/blueprintGenerator';
import type { BlueprintJSON, ParsedManifest } from '../types/blueprint.types';
import { CrewAIDetector, LangGraphDetector } from '../services/blueprinting/frameworkDetectors';
import { DependencyLocking } from '../services/deterministic/dependencyLocking';
import * as ui from './utils';

interface InitOptions {
  output?: string;
}

function resolvePythonVersion(raw: string): string {
  const match = raw?.match(/3\.(9|10|11|12)/);
  return match ? `3.${match[1]}` : '3.11';
}

function toRequirementLine(name: string, version: string): string {
  if (!version || version === 'latest' || version === '*') {
    return name;
  }
  if (/^[<>=!~]/.test(version) || version.includes(',')) {
    return `${name}${version}`;
  }
  return `${name}==${version}`;
}

/**
 * Best-effort pip-compile lockfile. Non-fatal if pip-tools is missing or compile fails.
 * Writes `requirements.lock` at the project root for deploy/fleet consumers.
 */
async function tryGenerateLockfile(
  projectPath: string,
  manifest: ParsedManifest,
): Promise<void> {
  const lockStart = Date.now();
  let tempRequirementsPath: string | null = null;

  try {
    const existingRequirements = path.join(projectPath, 'requirements.txt');
    let requirementsPath = existingRequirements;

    try {
      await fs.access(existingRequirements);
    } catch {
      const deps = manifest.allDependencies ?? {};
      if (Object.keys(deps).length === 0) {
        return;
      }

      const auraopsDir = path.join(projectPath, '.auraops');
      await fs.mkdir(auraopsDir, { recursive: true });
      tempRequirementsPath = path.join(auraopsDir, '_requirements_for_lock.txt');
      const lines = Object.entries(deps).map(([name, ver]) =>
        toRequirementLine(name, typeof ver === 'string' ? ver : String(ver)),
      );
      await fs.writeFile(tempRequirementsPath, `${lines.join('\n')}\n`);
      requirementsPath = tempRequirementsPath;
    }

    const pythonVersion = resolvePythonVersion(manifest.pythonVersion);
    const locking = new DependencyLocking();
    const result = await locking.generateLockfile(requirementsPath, pythonVersion);

    const destPath = path.join(projectPath, 'requirements.lock');
    await fs.copyFile(result.lockPath, destPath);
    ui.step(`Lockfile written: ${destPath}`, ui.formatMs(Date.now() - lockStart));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ui.warn(`Dependency locking skipped (pip-compile optional): ${message}`);
  } finally {
    if (tempRequirementsPath) {
      await fs.unlink(tempRequirementsPath).catch(() => undefined);
    }
  }
}

export async function runInit(projectPath: string, options: InitOptions): Promise<void> {
  const start = Date.now();
  const resolvedPath = path.resolve(projectPath);

  ui.header('AuraOps Init');
  ui.info(`Scanning project: ${resolvedPath}`);
  ui.blank();

  try {
    await fs.access(resolvedPath);
  } catch {
    ui.fail(`Project path not found: ${resolvedPath}`);
    process.exit(1);
  }

  const parser = new ManifestParser();
  const detector = new FrameworkDetector();
  const langGraphDetector = new LangGraphDetector();
  const crewAIDetector = new CrewAIDetector();
  const generator = new BlueprintGenerator();

  const parseStart = Date.now();
  const manifest = await parser.parse(resolvedPath);
  const depCount = Object.keys(manifest.allDependencies).length;
  ui.step(`Manifest parsed (${depCount} dependencies)`, ui.formatMs(Date.now() - parseStart));

  await tryGenerateLockfile(resolvedPath, manifest);

  const langGraphStart = Date.now();
  const langGraphAnalysis = await langGraphDetector.analyze(resolvedPath);
  if (langGraphAnalysis) {
    ui.step(
      `LangGraph StateGraph detected (${langGraphAnalysis.stateType} state)`,
      ui.formatMs(Date.now() - langGraphStart),
    );
  }

  const crewAIStart = Date.now();
  const crewAIAnalysis = await crewAIDetector.analyze(resolvedPath);
  if (crewAIAnalysis) {
    ui.step(
      `CrewAI detected (${crewAIAnalysis.agentCount} agents, ${crewAIAnalysis.totalToolCount} tools)`,
      ui.formatMs(Date.now() - crewAIStart),
    );
  }

  const detectStart = Date.now();
  const fingerprint = detector.detect(manifest, langGraphAnalysis, crewAIAnalysis);
  ui.step(
    `Framework detected: ${fingerprint.framework} ${fingerprint.version}`,
    ui.formatMs(Date.now() - detectStart),
  );

  const genStart = Date.now();
  const blueprint = await generator.generate(fingerprint, manifest, resolvedPath);
  const entryPointWarning = (blueprint as BlueprintJSON & { _entryPointWarning?: string })._entryPointWarning;
  ui.step(`Blueprint generated (id: ${blueprint.id.slice(0, 8)}...)`, ui.formatMs(Date.now() - genStart));

  const outputDir = options.output
    ? path.resolve(options.output)
    : path.join(resolvedPath, '.auraops');
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'blueprint.json');
  await fs.writeFile(outputPath, JSON.stringify(blueprint, null, 2));
  ui.step(`Saved to: ${outputPath}`);

  ui.blank();
  ui.label('Framework', `${fingerprint.framework} (${fingerprint.version})`);
  ui.label('Python', fingerprint.pythonVersion);
  ui.label('CUDA', fingerprint.cudaVersion);
  ui.label('Base Image', `${blueprint.systemRequirements.baseImageId}:${blueprint.systemRequirements.baseImageTag}`);
  ui.label('GPU Memory', `${blueprint.deploymentConfig.gpuMemoryGB}GB`);
  if (fingerprint.langGraph) {
    ui.label('GPU Tier', fingerprint.langGraph.recommendedGpuTier);
    ui.label(
      'State Size (est.)',
      `${(fingerprint.langGraph.estimatedStateSizeBytes / 1024).toFixed(1)}KB`,
    );
  }
  if (fingerprint.crewAI) {
    ui.label('GPU Tier', fingerprint.crewAI.recommendedGpuTier);
    ui.label('Agent Count', String(fingerprint.crewAI.agentCount));
    ui.label('Tool Count', String(fingerprint.crewAI.totalToolCount));
  }
  ui.label('Use Case', fingerprint.primaryUse);
  ui.blank();
  if (entryPointWarning) {
    ui.blank();
    ui.warn('Entry-point detection:');
    ui.info(`  ${entryPointWarning}`);
  }

  ui.success(`Init complete in ${ui.formatMs(Date.now() - start)}`);
}

export const initCommand = new Command('init')
  .description('Initialize AuraOps for a project - parse manifest, detect framework, generate blueprint')
  .argument('[path]', 'Path to project directory', '.')
  .option('-o, --output <dir>', 'Output directory for blueprint (default: <project>/.auraops)')
  .action(async (projectPath: string, options: InitOptions) => {
    try {
      await runInit(projectPath, options);
    } catch (error: unknown) {
      ui.handleError(error);
    }
  });
