import type { ParsedManifest, FrameworkFingerprint } from '../../types/blueprint.types';
import { FrameworkDetectionError } from '../../utils/errors';
import { logger } from '../../utils/logger';

type SupportedFramework = 'pytorch' | 'langchain' | 'transformers' | 'jax' | 'tensorflow';

export class FrameworkDetector {
  detect(manifest: ParsedManifest): FrameworkFingerprint {
    const framework = this.identifyFramework(manifest);
    const version = this.getFrameworkVersion(manifest, framework);
    const cudaVersion = this.determineCudaVersion(manifest, framework);
    const pythonVersion = manifest.pythonVersion;
    const primaryUse = this.inferPrimaryUse(manifest);

    logger.info(
      `Framework detected: ${framework} v${version} (CUDA ${cudaVersion}, Python ${pythonVersion})`,
    );

    return {
      framework,
      version,
      cudaVersion,
      pythonVersion,
      primaryUse,
    };
  }

  private identifyFramework(manifest: ParsedManifest): SupportedFramework {
    const deps = manifest.allDependencies;

    const scores = {
      langchain: this.scoreHit(deps, ['langchain', 'langchain-core']),
      pytorch: this.scoreHit(deps, ['torch', 'pytorch']),
      transformers: this.scoreHit(deps, ['transformers', 'huggingface-hub']),
      jax: this.scoreHit(deps, ['jax', 'jaxlib']),
      tensorflow: this.scoreHit(deps, ['tensorflow', 'tf-nightly']),
    };

    // Framework hierarchy for tiebreaking (higher-level frameworks win)
    const hierarchy: SupportedFramework[] = ['langchain', 'transformers', 'pytorch', 'jax', 'tensorflow'];
    
    // Filter frameworks with non-zero scores, sorted by priority
    const candidates = hierarchy.filter(fw => scores[fw] > 0).sort((a, b) => scores[b] - scores[a]);
    
    if (candidates.length === 0) {
      throw new FrameworkDetectionError(
        'Could not detect supported framework. Supported: pytorch, langchain, transformers, jax, tensorflow',
      );
    }

    return candidates[0];
  }

  private scoreHit(deps: Record<string, string>, keywords: string[]): number {
    return keywords.filter(k => k in deps).length * 10;
  }

  private getFrameworkVersion(manifest: ParsedManifest, framework: SupportedFramework): string {
    const versionMap: Record<SupportedFramework, string> = {
      pytorch: manifest.torchVersion || '2.1.0',
      langchain: manifest.langchainVersion || '0.1.0',
      transformers: manifest.allDependencies['transformers'] || '4.30.0',
      jax: manifest.allDependencies['jax'] || '0.4.0',
      tensorflow: manifest.allDependencies['tensorflow'] || '2.13.0',
    };

    return versionMap[framework] || 'latest';
  }

  private determineCudaVersion(manifest: ParsedManifest, framework: SupportedFramework): string {
    if (manifest.cudaVersion) return manifest.cudaVersion;

    const cudaMappings: Record<SupportedFramework, Record<string, string>> = {
      pytorch: {
        '2.1': '12.1',
        '2.0': '11.8',
        '1.13': '11.7',
      },
      langchain: { '*': '12.1' },
      transformers: { '*': '12.1' },
      jax: {
        '0.4': '12.1',
        '0.3': '11.8',
      },
      tensorflow: {
        '2.13': '11.8',
        '2.12': '11.8',
      },
    };

    const frameworkVer = this.getFrameworkVersion(manifest, framework);
    const majorVer = frameworkVer.split('.')[0] + '.' + frameworkVer.split('.')[1];
    const mapping = cudaMappings[framework];

    return mapping[majorVer] || mapping['*'] || '12.1';
  }

  private inferPrimaryUse(
    manifest: ParsedManifest,
  ): 'inference' | 'training' | 'agentic' {
    const deps = manifest.allDependencies;

    if (
      deps['langchain'] &&
      (deps['langchain-community'] || deps['langgraph'] || deps['pydantic-ai'])
    ) {
      return 'agentic';
    }

    if (deps['pytorch-lightning'] || deps['transformers']) {
      return 'training';
    }

    return 'inference';
  }
}

export default FrameworkDetector;
