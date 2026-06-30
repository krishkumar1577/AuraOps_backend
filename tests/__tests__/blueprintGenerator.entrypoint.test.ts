import * as path from 'path';
import { BlueprintGenerator } from '../../src/services/blueprinting/blueprintGenerator';
import type { FrameworkFingerprint, ParsedManifest } from '../../src/types/blueprint.types';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

const baseFingerprint = (): FrameworkFingerprint => ({
  framework: 'langchain',
  version: '0.1.0',
  cudaVersion: '12.1',
  pythonVersion: '3.11',
  primaryUse: 'agentic',
});

const baseManifest = (): ParsedManifest => ({
  framework: 'langchain',
  frameworkVersion: '0.1.0',
  pythonVersion: '3.11',
  allDependencies: { langchain: '0.1.0' },
});

describe('BlueprintGenerator — entrypoint wiring', () => {
  const generator = new BlueprintGenerator();

  it('emits `python main.py` for the existing main.py project (no regression)', async () => {
    const bp = await generator.generate(
      baseFingerprint(),
      baseManifest(),
      path.join(FIXTURES, 'entrypoint-main'),
    );
    expect(bp.deploymentConfig.entrypoint).toBe('python main.py');
  });

  it('emits `python agent.py` for the agent.py project (fixes the original bug)', async () => {
    const bp = await generator.generate(
      baseFingerprint(),
      baseManifest(),
      path.join(FIXTURES, 'entrypoint-agent'),
    );
    expect(bp.deploymentConfig.entrypoint).toBe('python agent.py');
  });

  it('emits `python sample/main.py` when pyproject.toml declares a scripts entry', async () => {
    const bp = await generator.generate(
      baseFingerprint(),
      baseManifest(),
      path.join(FIXTURES, 'entrypoint-pyproject'),
    );
    expect(bp.deploymentConfig.entrypoint).toBe('python sample/main.py');
  });

  it('attaches a _entryPointWarning on the blueprint when detection is ambiguous', async () => {
    const bp: Awaited<ReturnType<typeof generator.generate>> & { _entryPointWarning?: string } = await generator.generate(
      baseFingerprint(),
      baseManifest(),
      path.join(FIXTURES, 'entrypoint-ambiguous'),
    ) as typeof bp & { _entryPointWarning?: string };
    // Still emits a valid entrypoint (heuristic or fallback), but the
    // warning is attached so the CLI can surface it.
    expect(bp.deploymentConfig.entrypoint.startsWith('python ')).toBe(true);
    expect(bp._entryPointWarning).toBeDefined();
    expect(bp._entryPointWarning).toMatch(/Multiple candidate entry files/);
  });
});
