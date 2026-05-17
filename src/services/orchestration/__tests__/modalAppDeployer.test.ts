import { ModalAppDeployer } from '../modalAppDeployer';
import type { BlueprintJSON } from '../../../types/blueprint.types';

describe('ModalAppDeployer', () => {
  const mockBlueprint: BlueprintJSON = {
    id: 'bp_test123',
    timestamp: new Date().toISOString(),
    framework: {
      framework: 'langchain',
      version: '0.1.0',
      cudaVersion: '12.1',
      pythonVersion: '3.11',
      primaryUse: 'agentic',
    },
    dependencyLock: {
      'langchain': '0.1.0',
      'torch': '2.1.0',
      'transformers': '4.30.0',
      'pydantic': '2.0.0',
    },
    systemRequirements: {
      pythonVersion: '3.11',
      cudaVersion: '12.1',
      cuDNNVersion: '8.6',
      baseImageId: 'python',
      baseImageTag: '3.11-slim',
      systemPackages: [],
    },
    customModels: [],
    deploymentConfig: {
      entrypoint: 'main.py',
      runtime: 'python',
      memoryMB: 4096,
      gpuRequired: true,
      gpuMemoryGB: 16,
    },
    checksums: {
      allDepsHash: 'sha256_abc123',
      blueprintHash: 'sha256_def456',
    },
  };

  describe('generateModalApp', () => {
    it('should generate valid Python code for LangChain', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('import modal');
      expect(code).toContain('class AuraOpsAgent');
      expect(code).toContain('@modal.enter()');
      expect(code).toContain('@modal.fastapi_endpoint');
      expect(code).toContain('def load(self)');
      expect(code).toContain('def endpoint(self, request: InferenceRequest)');
      expect(code).toContain('class InferenceRequest');
      expect(code).toContain('class InferenceResponse');
    });

    it('should include LangChain loader code', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('from langchain_openai import ChatOpenAI');
      expect(code).toContain('self.agent = initialize_agent');
    });

    it('should include all dependencies in pip_install', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('"langchain==0.1.0"');
      expect(code).toContain('"torch==2.1.0"');
      expect(code).toContain('"transformers==4.30.0"');
      expect(code).toContain('"pydantic==2.0.0"');
    });

    it('should select L4 GPU for 16GB requirement', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('modal.gpu.L4()');
    });

    it('should generate code for PyTorch/Transformers', () => {
      const pytorchBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        framework: {
          ...mockBlueprint.framework,
          framework: 'transformers',
        },
      };

      const code = ModalAppDeployer.generateModalApp(pytorchBlueprint, 'dep_pytorch123');

      expect(code).toContain('from transformers import AutoTokenizer, AutoModelForCausalLM');
      expect(code).toContain('AutoTokenizer.from_pretrained');
      expect(code).toContain('AutoModelForCausalLM.from_pretrained');
    });

    it('should generate code for JAX', () => {
      const jaxBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        framework: {
          ...mockBlueprint.framework,
          framework: 'jax',
        },
      };

      const code = ModalAppDeployer.generateModalApp(jaxBlueprint, 'dep_jax123');

      expect(code).toContain('import jax');
    });

    it('should generate code for TensorFlow', () => {
      const tfBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        framework: {
          ...mockBlueprint.framework,
          framework: 'tensorflow',
        },
      };

      const code = ModalAppDeployer.generateModalApp(tfBlueprint, 'dep_tf123');

      expect(code).toContain('import tensorflow as tf');
      expect(code).toContain('tf.keras.models.load_model');
    });

    it('should select T4 GPU for ≤8GB requirement', () => {
      const smallBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        deploymentConfig: {
          ...mockBlueprint.deploymentConfig,
          gpuMemoryGB: 8,
        },
      };

      const code = ModalAppDeployer.generateModalApp(smallBlueprint, 'dep_small123');

      expect(code).toContain('modal.gpu.T4()');
    });

    it('should select A100 GPU for >24GB requirement', () => {
      const largeBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        deploymentConfig: {
          ...mockBlueprint.deploymentConfig,
          gpuMemoryGB: 40,
        },
      };

      const code = ModalAppDeployer.generateModalApp(largeBlueprint, 'dep_large123');

      expect(code).toContain('modal.gpu.A100()');
    });

    it('should include deployment ID in app name', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_abc123xyz');

      expect(code).toContain('auraops-dep_abc123xyz');
      expect(code).toContain('Deployment ID: dep_abc123xyz');
    });

    it('should include InferenceRequest and InferenceResponse schemas', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('class InferenceRequest(BaseModel):');
      expect(code).toContain('input: str');
      expect(code).toContain('class InferenceResponse(BaseModel):');
      expect(code).toContain('output: str');
      expect(code).toContain('deployment_id: str');
      expect(code).toContain('processing_time_ms: float');
    });

    it('should include health check endpoint', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('def health_check()');
    });

    it('should handle custom models in loader', () => {
      const customBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        customModels: [
          {
            name: 'meta-llama/Llama-2-7b',
            path: '/models/llama-7b',
            hash: 'sha256_model',
            size: 13500000000,
          },
        ],
      };

      const code = ModalAppDeployer.generateModalApp(customBlueprint, 'dep_custom123');

      expect(code).toContain('@modal.enter()');
      expect(code).toContain('def load(self)');
    });
  });

  describe('GPU selection', () => {
    const gpuTests = [
      { memory: 8, expected: 'modal.gpu.T4()' },
      { memory: 16, expected: 'modal.gpu.L4()' },
      { memory: 24, expected: 'modal.gpu.A10G()' },
      { memory: 40, expected: 'modal.gpu.A100()' },
      { memory: 80, expected: 'modal.gpu.A100(count=2)' },
    ];

    gpuTests.forEach(({ memory, expected }) => {
      it(`should select correct GPU for ${memory}GB requirement`, () => {
        const blueprint: BlueprintJSON = {
          ...mockBlueprint,
          deploymentConfig: {
            ...mockBlueprint.deploymentConfig,
            gpuMemoryGB: memory,
          },
        };

        const code = ModalAppDeployer.generateModalApp(blueprint, 'dep_gpu_test');

        expect(code).toContain(expected);
      });
    });
  });

  describe('Framework loaders', () => {
    it('should generate LangChain loader', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_lc123');

      expect(code).toContain('from langchain_openai import ChatOpenAI');
      expect(code).toContain('from langchain.agents import initialize_agent');
    });

    it('should generate Transformers loader', () => {
      const tfBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        framework: { ...mockBlueprint.framework, framework: 'transformers' },
      };

      const code = ModalAppDeployer.generateModalApp(tfBlueprint, 'dep_tf123');

      expect(code).toContain('from transformers import AutoTokenizer, AutoModelForCausalLM');
      expect(code).toContain('torch_dtype=torch.float16');
      expect(code).toContain('device_map="auto"');
    });
  });
});
