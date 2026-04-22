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

  it('should throw error for unsupported framework', () => {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {
        'some-random-package': '1.0.0',
      },
    };

    expect(() => detector.detect(manifest)).toThrow();
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
});
