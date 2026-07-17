import type {
  ParsedManifest,
  FrameworkFingerprint,
  LangGraphMetadata,
  CrewAIMetadata,
  DetectedFramework,
} from '../../types/blueprint.types';
import { logger } from '../../utils/logger';

/**
 * Detect AI stack from deps + optional CrewAI/LangGraph analysis.
 *
 * Founders / AI engineers often ship:
 * - CrewAI / LangGraph / LangChain agents
 * - GGUF + llama-cpp-python
 * - plain agent.py with a run()/handle()
 *
 * We never hard-fail when a Python project has *some* signal (deps or
 * empty deps with source). Fall back to `python` so `init` always works.
 */
export class FrameworkDetector {
  detect(
    manifest: ParsedManifest,
    langGraphAnalysis?: LangGraphMetadata | null,
    crewAIAnalysis?: CrewAIMetadata | null,
  ): FrameworkFingerprint {
    const framework = this.identifyFramework(manifest, langGraphAnalysis, crewAIAnalysis);
    const version = this.getFrameworkVersion(manifest, framework);
    const cudaVersion = this.determineCudaVersion(manifest, framework);
    const pythonVersion = manifest.pythonVersion;
    const primaryUse = this.inferPrimaryUse(manifest, crewAIAnalysis, framework);

    const fingerprint: FrameworkFingerprint = {
      framework,
      version,
      cudaVersion,
      pythonVersion,
      primaryUse,
    };

    if (framework === 'langgraph' && langGraphAnalysis) {
      fingerprint.langGraph = langGraphAnalysis;
    }
    if (framework === 'crewai' && crewAIAnalysis) {
      fingerprint.crewAI = crewAIAnalysis;
    }

    logger.info(
      `Framework detected: ${framework} v${version} (CUDA ${cudaVersion}, Python ${pythonVersion})`,
    );

    return fingerprint;
  }

  private identifyFramework(
    manifest: ParsedManifest,
    langGraphAnalysis?: LangGraphMetadata | null,
    crewAIAnalysis?: CrewAIMetadata | null,
  ): DetectedFramework {
    if (langGraphAnalysis?.detected) {
      return 'langgraph';
    }
    if (crewAIAnalysis?.detected) {
      return 'crewai';
    }

    const deps = manifest.allDependencies;
    const depKeys = Object.keys(deps).map((k) => k.toLowerCase());

    // Explicit GGUF / local LLM stack (common founder path) before HF-hub noise
    if (this.hasAny(depKeys, ['llama-cpp-python', 'llama_cpp', 'ctransformers', 'ggml', 'ctranslate2'])) {
      return 'python';
    }

    const scores: Record<Exclude<DetectedFramework, 'python'>, number> = {
      langgraph: this.scoreHit(deps, ['langgraph']),
      crewai: this.scoreHit(deps, ['crewai']),
      langchain: this.scoreHit(deps, ['langchain', 'langchain-core']),
      pytorch: this.scoreHit(deps, ['torch', 'pytorch']),
      // Only real transformers package — NOT huggingface-hub alone (CLI/utils)
      transformers: this.scoreHit(deps, ['transformers']),
      jax: this.scoreHit(deps, ['jax', 'jaxlib']),
      tensorflow: this.scoreHit(deps, ['tensorflow', 'tf-nightly']),
    };

    const hierarchy: Array<Exclude<DetectedFramework, 'python'>> = [
      'langgraph',
      'crewai',
      'langchain',
      'transformers',
      'pytorch',
      'jax',
      'tensorflow',
    ];

    const candidates = hierarchy
      .filter((fw) => scores[fw] > 0)
      .sort((a, b) => scores[b] - scores[a]);

    if (candidates.length > 0) {
      return candidates[0];
    }

    // Soft fallback: any Python agent project is deployable via user entrypoint
    return 'python';
  }

  private hasAny(depKeys: string[], needles: string[]): boolean {
    const set = new Set(depKeys);
    return needles.some((n) => set.has(n.toLowerCase()));
  }

  private scoreHit(deps: Record<string, string>, keywords: string[]): number {
    const keys = Object.keys(deps).map((k) => k.toLowerCase());
    return keywords.filter((k) => keys.includes(k.toLowerCase())).length * 10;
  }

  private getFrameworkVersion(
    manifest: ParsedManifest,
    framework: DetectedFramework,
  ): string {
    const deps = manifest.allDependencies;
    const pick = (...names: string[]): string | undefined => {
      for (const n of names) {
        const v = deps[n] ?? deps[n.toLowerCase()];
        if (v) return this.normalizeVersionLabel(v);
      }
      return undefined;
    };

    switch (framework) {
      case 'pytorch':
        return this.normalizeVersionLabel(manifest.torchVersion || pick('torch', 'pytorch') || '2.1.0');
      case 'langchain':
        return this.normalizeVersionLabel(
          manifest.langchainVersion || pick('langchain', 'langchain-core') || '0.1.0',
        );
      case 'langgraph':
        return this.normalizeVersionLabel(pick('langgraph') || '0.2.0');
      case 'crewai':
        return this.normalizeVersionLabel(pick('crewai') || '0.11.2');
      case 'transformers':
        return this.normalizeVersionLabel(pick('transformers') || '4.30.0');
      case 'jax':
        return this.normalizeVersionLabel(pick('jax') || '0.4.0');
      case 'tensorflow':
        return this.normalizeVersionLabel(pick('tensorflow') || '2.13.0');
      case 'python':
        return this.normalizeVersionLabel(
          pick('llama-cpp-python', 'llama_cpp', 'ctransformers') || manifest.pythonVersion || '3.11',
        );
      default:
        return 'latest';
    }
  }

  /** Strip operators for display/label only (e.g. ">=0.3.8" → "0.3.8"). */
  private normalizeVersionLabel(raw: string): string {
    const cleaned = raw.replace(/^[<>=!~^]+/, '').split(',')[0]?.trim() || raw;
    return cleaned === 'latest' || cleaned === '*' ? cleaned : cleaned || 'latest';
  }

  private determineCudaVersion(
    manifest: ParsedManifest,
    framework: DetectedFramework,
  ): string {
    if (manifest.cudaVersion) return manifest.cudaVersion;

    if (framework === 'python') {
      return '12.1';
    }

    const cudaMappings: Record<string, Record<string, string>> = {
      pytorch: {
        '2.1': '12.1',
        '2.0': '11.8',
        '1.13': '11.7',
      },
      langchain: { '*': '12.1' },
      langgraph: { '*': '12.1' },
      crewai: { '*': '12.1' },
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
    const parts = frameworkVer.split('.');
    const majorVer = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : frameworkVer;
    const mapping = cudaMappings[framework] || { '*': '12.1' };

    return mapping[majorVer] || mapping['*'] || '12.1';
  }

  private inferPrimaryUse(
    manifest: ParsedManifest,
    crewAIAnalysis: CrewAIMetadata | null | undefined,
    framework: DetectedFramework,
  ): 'inference' | 'training' | 'agentic' {
    const deps = manifest.allDependencies;
    const keys = Object.keys(deps).map((k) => k.toLowerCase());

    if (crewAIAnalysis?.detected || keys.includes('crewai')) {
      return 'agentic';
    }

    if (
      keys.includes('langchain') &&
      (keys.includes('langchain-community') || keys.includes('langgraph') || keys.includes('pydantic-ai'))
    ) {
      return 'agentic';
    }

    if (keys.includes('langgraph') || framework === 'langgraph' || framework === 'crewai') {
      return 'agentic';
    }

    if (keys.includes('pytorch-lightning')) {
      return 'training';
    }

    // GGUF / llama-cpp / plain agents → inference
    if (
      framework === 'python' ||
      keys.includes('llama-cpp-python') ||
      keys.includes('ctransformers')
    ) {
      return 'inference';
    }

    if (keys.includes('transformers') && keys.includes('datasets') && keys.includes('accelerate')) {
      return 'training';
    }

    return 'inference';
  }
}

export default FrameworkDetector;
