import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ManifestParser } from '../services/blueprinting/manifestParser';
import { FrameworkDetector } from '../services/blueprinting/frameworkDetector';
import { BlueprintGenerator } from '../services/blueprinting/blueprintGenerator';
import { LangGraphDetector } from '../services/blueprinting/frameworkDetectors';
import * as ui from './utils';

interface InitOptions {
  output?: string;
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
  const generator = new BlueprintGenerator();

  const parseStart = Date.now();
  const manifest = await parser.parse(resolvedPath);
  const depCount = Object.keys(manifest.allDependencies).length;
  ui.step(`Manifest parsed (${depCount} dependencies)`, ui.formatMs(Date.now() - parseStart));

  const langGraphStart = Date.now();
  const langGraphAnalysis = await langGraphDetector.analyze(resolvedPath);
  if (langGraphAnalysis) {
    ui.step(
      `LangGraph StateGraph detected (${langGraphAnalysis.stateType} state)`,
      ui.formatMs(Date.now() - langGraphStart),
    );
  }

  const detectStart = Date.now();
  const fingerprint = detector.detect(manifest, langGraphAnalysis);
  ui.step(
    `Framework detected: ${fingerprint.framework} ${fingerprint.version}`,
    ui.formatMs(Date.now() - detectStart),
  );

  const genStart = Date.now();
  const blueprint = generator.generate(fingerprint, manifest, resolvedPath);
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
  ui.label('Use Case', fingerprint.primaryUse);
  ui.blank();
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
