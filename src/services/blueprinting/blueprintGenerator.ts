import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import type { BlueprintJSON, FrameworkFingerprint, ParsedManifest } from '../../types/blueprint.types';
import { logger } from '../../utils/logger';

export class BlueprintGenerator {
  generate(
    fingerprint: FrameworkFingerprint,
    manifest: ParsedManifest,
    _projectPath: string,
  ): BlueprintJSON {
    const baseImage = this.selectBaseImage(fingerprint);

    const blueprint: BlueprintJSON = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      framework: fingerprint,
      dependencyLock: manifest.allDependencies,
      systemRequirements: {
        pythonVersion: fingerprint.pythonVersion,
        cudaVersion: fingerprint.cudaVersion,
        cuDNNVersion: this.mapCudaToCuDNN(fingerprint.cudaVersion),
        baseImageId: baseImage.id,
        baseImageTag: baseImage.tag,
      },
      customModels: [],
      deploymentConfig: {
        entrypoint: 'python main.py',
        runtime: 'python',
        memoryMB: 4096,
        gpuRequired: true,
        gpuMemoryGB: this.estimateGpuMemory(fingerprint),
      },
      checksums: {
        allDepsHash: this.hashDependencies(manifest.allDependencies),
        blueprintHash: '',
      },
    };

    const copy: any = JSON.parse(JSON.stringify(blueprint));
    copy.checksums.blueprintHash = undefined;
    blueprint.checksums.blueprintHash = this.hashBlueprint(copy);

    logger.info(
      `✓ Blueprint generated: ${blueprint.id} (${blueprint.framework.framework} ${blueprint.framework.version})`,
    );

    return blueprint;
  }

  private selectBaseImage(
    fingerprint: FrameworkFingerprint,
  ): { id: string; tag: string } {
    const imageMap: Record<string, string> = {
      'pytorch-2.1-cuda-12.1': 'aura-pytorch-2.1-cuda-12.1',
      'pytorch-2.0-cuda-11.8': 'aura-pytorch-2.0-cuda-11.8',
      'transformers-4.30-pytorch-2.1-cuda-12.1': 'aura-transformers-4.30-torch2.1-cuda12.1',
      'langchain-0.1-pytorch-2.1-cuda-12.1': 'aura-langchain-0.1-torch2.1-cuda12.1',
      'jax-0.4-cuda-12.1': 'aura-jax-0.4-cuda-12.1',
    };

    const key = `${fingerprint.framework}-${fingerprint.version}-cuda-${fingerprint.cudaVersion}`;
    const imageId = imageMap[key] || 'aura-pytorch-2.1-cuda-12.1';

    return { id: imageId, tag: 'latest' };
  }

  private mapCudaToCuDNN(cudaVersion: string): string {
    const mappings: Record<string, string> = {
      '12.1': '8.9.0',
      '11.8': '8.6.0',
      '11.7': '8.5.0',
    };
    return mappings[cudaVersion] || '8.9.0';
  }

  private estimateGpuMemory(fingerprint: FrameworkFingerprint): number {
    if (fingerprint.primaryUse === 'training') return 24;
    if (fingerprint.primaryUse === 'agentic') return 16;
    return 8;
  }

  private hashDependencies(deps: Record<string, string>): string {
    const sorted = Object.entries(deps)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return this.sha256(sorted);
  }

  private hashBlueprint(blueprint: any): string {
    return this.sha256(JSON.stringify(blueprint));
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}

export default BlueprintGenerator;
