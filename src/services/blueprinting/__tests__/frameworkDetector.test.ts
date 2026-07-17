import { FrameworkDetector } from '../frameworkDetector';
import type { ParsedManifest } from '../../../types/blueprint.types';

describe('FrameworkDetector', () => {
  let detector: FrameworkDetector;

  beforeEach(() => {
    detector = new FrameworkDetector();
  });

  it('should detect PyTorch + LangChain project (agentic)', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        torch: '2.1.0',
        langchain: '0.1.0',
        'langchain-community': '0.0.10',
      },
    };

    const result = detector.detect(manifest);

    expect(result.framework).toBe('langchain');
    expect(result.version).toBe('0.1.0');
    expect(result.cudaVersion).toBe('12.1');
    expect(result.pythonVersion).toBe('3.11');
    expect(result.primaryUse).toBe('agentic');
  });

  it('should detect pure PyTorch project', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.10',
      allDependencies: {
        torch: '2.0.0',
        torchvision: '0.15.0',
      },
      torchVersion: '2.0.0',
    };

    const result = detector.detect(manifest);

    expect(result.framework).toBe('pytorch');
    expect(result.cudaVersion).toBe('11.8');
  });

  it('should detect Transformers + PyTorch', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        transformers: '4.30.0',
        torch: '2.1.0',
      },
      torchVersion: '2.1.0',
    };

    const result = detector.detect(manifest);

    expect(result.framework).toBe('transformers');
  });

  it('should detect JAX', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        jax: '0.4.0',
        jaxlib: '0.4.0',
      },
    };

    const result = detector.detect(manifest);

    expect(result.framework).toBe('jax');
    expect(result.cudaVersion).toBe('12.1');
  });

  it('should fall back to python for unknown / plain agent deps', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        'some-random-package': '1.0.0',
      },
    };

    const result = detector.detect(manifest);
    expect(result.framework).toBe('python');
    expect(result.primaryUse).toBe('inference');
  });

  it('should detect llama-cpp-python GGUF stack as python (not transformers)', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        'llama-cpp-python': '>=0.3.8',
      },
    };

    const result = detector.detect(manifest);
    expect(result.framework).toBe('python');
    expect(result.primaryUse).toBe('inference');
  });

  it('should not treat huggingface-hub alone as transformers', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        'huggingface-hub': '0.26.0',
      },
    };

    const result = detector.detect(manifest);
    expect(result.framework).toBe('python');
  });

  it('should infer training use case', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        'pytorch-lightning': '2.0.0',
        torch: '2.1.0',
      },
      torchVersion: '2.1.0',
    };

    const result = detector.detect(manifest);

    expect(result.primaryUse).toBe('training');
  });

  it('should infer inference use case as default', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        torch: '2.1.0',
      },
      torchVersion: '2.1.0',
    };

    const result = detector.detect(manifest);

    expect(result.primaryUse).toBe('inference');
  });

  it('should detect langgraph when analysis is provided', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        langgraph: '0.2.0',
        langchain: '0.2.0',
      },
    };

    const langGraphAnalysis = {
      detected: true as const,
      stateType: 'typeddict' as const,
      stateClassName: 'AgentState',
      estimatedStateSizeBytes: 8192,
      checkpointing: false,
      recommendedGpuTier: 'T4' as const,
      recommendedGpuMemoryGB: 8 as const,
    };

    const result = detector.detect(manifest, langGraphAnalysis);

    expect(result.framework).toBe('langgraph');
    expect(result.version).toBe('0.2.0');
    expect(result.langGraph).toEqual(langGraphAnalysis);
    expect(result.primaryUse).toBe('agentic');
  });

  it('should prioritize crewai analysis over plain langchain dependencies', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        crewai: '0.11.2',
        langchain: '0.2.0',
        'langchain-core': '0.2.0',
      },
      langchainVersion: '0.2.0',
    };

    const crewAIAnalysis = {
      detected: true as const,
      agentCount: 5,
      totalToolCount: 10,
      agents: [
        { name: 'researcher', toolCount: 2 },
        { name: 'analyst', toolCount: 2 },
        { name: 'engineer', toolCount: 2 },
        { name: 'reviewer', toolCount: 1 },
        { name: 'writer', toolCount: 3 },
      ],
      memoryType: 'long_term' as const,
      hasCustomCrewSubclass: false,
      recommendedGpuTier: 'L4' as const,
      recommendedGpuMemoryGB: 16 as const,
      requiresHumanReview: false,
    };

    const result = detector.detect(manifest, null, crewAIAnalysis);

    expect(result.framework).toBe('crewai');
    expect(result.version).toBe('0.11.2');
    expect(result.crewAI).toEqual(crewAIAnalysis);
    expect(result.primaryUse).toBe('agentic');
  });
});
