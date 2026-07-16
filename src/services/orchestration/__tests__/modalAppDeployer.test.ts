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
      expect(code).toContain('def endpoint(self, request: dict) -> dict:');
      expect(code).not.toContain('class InferenceRequest');
      expect(code).not.toContain('class InferenceResponse');
    });

    it('should include LangChain loader code inside load() method', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('from langchain_openai import ChatOpenAI');
      expect(code).toContain('self.agent = initialize_agent');
    });

    it('should not have third-party imports at module level (KRI-17)', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_lazy123');
      const beforeClass = code.split('class AuraOpsAgent')[0];

      expect(beforeClass).toContain('import modal');
      expect(beforeClass).not.toMatch(/from langchain|from transformers|import torch|import tensorflow|import jax/);
      expect(beforeClass).not.toContain('from typing import');
      expect(code).toContain('def load(self):');
      expect(code).toContain('request: dict) -> dict:');
    });

    it('should include all dependencies in pip_install', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('"langchain==0.1.0"');
      expect(code).toContain('"torch==2.1.0"');
      expect(code).toContain('"transformers==4.30.0"');
      expect(code).not.toContain('pydantic');
    });

    it('should select L4 GPU for 16GB requirement', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('gpu="L4"');
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

      expect(code).toContain('gpu="T4"');
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

      expect(code).toContain('gpu="A100"');
    });

    it('should include deployment ID in app name', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_abc123xyz');

      expect(code).toContain('auraops-dep_abc123xyz');
      expect(code).toContain('Deployment ID: dep_abc123xyz');
    });

    it('should include response format', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_test123');

      expect(code).toContain('"output": output');
      expect(code).toContain('"deployment_id"');
      expect(code).toContain('"processing_time_ms": processing_time');
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
      expect(code).toContain('AURAOPS_MODEL_PATH');
      expect(code).toContain('/models/llama-7b');
    });
  });

  describe('Secrets and env injection', () => {
    it('should inject env via os.environ.setdefault in load()', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_env123', {
        env: {
          OPENAI_API_KEY: 'sk-test-key',
          ANTHROPIC_API_KEY: 'ant-test',
        },
      });

      expect(code).toContain('os.environ.setdefault');
      expect(code).toContain('OPENAI_API_KEY');
      expect(code).toContain('sk-test-key');
      expect(code).toContain('ANTHROPIC_API_KEY');
      // Env bootstrap must live inside load(), not at module level
      const beforeClass = code.split('class AuraOpsAgent')[0];
      expect(beforeClass).not.toContain('os.environ.setdefault');
      expect(beforeClass).not.toContain('import torch');
    });

    it('should attach Modal secrets on @app.cls when secretNames provided', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_sec123', {
        secretNames: ['auraops-agent'],
      });

      expect(code).toContain('modal.Secret.from_name("auraops-agent")');
      expect(code).toContain('secrets=[');
    });

    it('should not emit secrets= when secretNames omitted', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_nosec');

      expect(code).not.toContain('Secret.from_name');
      expect(code).not.toContain('secrets=[');
    });
  });

  describe('Custom model weight bootstrap', () => {
    it('should generate https download bootstrap and model path', () => {
      const customBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        customModels: [
          {
            name: 'my-weights',
            path: 'https://example.com/weights/model.bin',
            hash: 'abc123hash',
            size: 1000,
          },
        ],
      };

      const code = ModalAppDeployer.generateModalApp(customBlueprint, 'dep_http_weights');

      expect(code).toContain('urllib.request');
      expect(code).toContain('/models/abc123hash');
      expect(code).toContain('AURAOPS_MODEL_PATH');
      expect(code).toContain('https://example.com/weights/model.bin');
      // Shared fridge: Volume + exists-check before download + commit on fill
      expect(code).toContain('modal.Volume.from_name("auraops-weights"');
      expect(code).toContain('create_if_missing=True');
      expect(code).toContain('volumes={"/models": weights_vol}');
      expect(code).toContain('if not os.path.exists(_dest_0):');
      expect(code).toContain('weights_vol.commit()');
      expect(code).toContain('Weight cache hit');
    });

    it('should generate s3 download bootstrap and include boto3 dep', () => {
      const customBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        customModels: [
          {
            name: 's3-model',
            path: 's3://aura-weights/models/llama.bin',
            hash: 's3hash99',
            size: 2000,
          },
        ],
      };

      const code = ModalAppDeployer.generateModalApp(customBlueprint, 'dep_s3_weights');

      expect(code).toContain('import boto3');
      expect(code).toContain('download_file');
      expect(code).toContain('/models/s3hash99');
      expect(code).toContain('AURAOPS_MODEL_PATH');
      expect(code).toContain('"boto3"');
      expect(code).toContain('modal.Volume.from_name("auraops-weights"');
      expect(code).toContain('volumes={"/models": weights_vol}');
      expect(code).toContain('if not os.path.exists(_dest_0):');
      expect(code).toContain('weights_vol.commit()');
    });

    it('should skip weight bootstrap and volume when customModels is empty', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_no_weights');

      expect(code).not.toContain('AURAOPS_MODEL_PATH');
      expect(code).not.toContain('download_file');
      expect(code).not.toContain('urlretrieve');
      expect(code).not.toContain('Volume.from_name');
      expect(code).not.toContain('volumes=');
      expect(code).not.toContain('weights_vol');
    });

    it('should not mount weight volume for local-only custom model paths', () => {
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

      const code = ModalAppDeployer.generateModalApp(customBlueprint, 'dep_local_model');

      expect(code).toContain('AURAOPS_MODEL_PATH');
      expect(code).not.toContain('Volume.from_name');
      expect(code).not.toContain('volumes=');
      expect(code).not.toContain('weights_vol.commit');
    });
  });

  describe('Multi-GPU', () => {
    it('should format single GPU without count suffix', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_single_gpu');

      expect(code).toContain('gpu="L4"');
      expect(code).not.toContain('gpu="L4:');
    });

    it('should format multi-GPU with count suffix', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_multi_gpu', { gpuCount: 4 });

      expect(code).toContain('gpu="L4:4"');
    });
  });

  describe('MCP unified ASGI', () => {
    it('should use asgi_app with MCP routes when enableMcp is true', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_mcp', { enableMcp: true });

      expect(code).toContain('@modal.asgi_app()');
      expect(code).toContain('/mcp/health');
      expect(code).toContain('/mcp/tools/call');
      expect(code).not.toContain('@modal.fastapi_endpoint');
    });

    it('should keep fastapi_endpoint when enableMcp is false', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_no_mcp');

      expect(code).toContain('@modal.fastapi_endpoint');
      expect(code).not.toContain('@modal.asgi_app()');
    });
  });

  describe('GPU selection', () => {
    const gpuTests = [
      { memory: 8, expected: 'gpu="T4"' },
      { memory: 16, expected: 'gpu="L4"' },
      { memory: 24, expected: 'gpu="A10G"' },
      { memory: 40, expected: 'gpu="A100"' },
      { memory: 80, expected: 'gpu="A100"' },
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

    it('should generate LangGraph loader with pre-compile at load()', () => {
      const lgBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        framework: {
          ...mockBlueprint.framework,
          framework: 'langgraph',
          langGraph: {
            detected: true,
            stateType: 'pydantic',
            stateClassName: 'AgentState',
            estimatedStateSizeBytes: 4096,
            checkpointing: false,
            recommendedGpuTier: 'T4',
            recommendedGpuMemoryGB: 8,
          },
        },
        deploymentConfig: {
          ...mockBlueprint.deploymentConfig,
          gpuMemoryGB: 8,
        },
      };

      const code = ModalAppDeployer.generateModalApp(lgBlueprint, 'dep_lg123');

      expect(code).toContain('compile_graph_for_state');
      expect(code).toContain('self.graph = compile_graph_for_state("pydantic")');
      expect(code).toContain('self.compiled_graph = self.graph.compile()');
      expect(code).toContain('✓ LangGraph pre-compiled at load()');
      expect(code).not.toMatch(/def endpoint[\s\S]*\.compile\(/);
    });

    it('should include langgraph inference branch without compile in endpoint', () => {
      const lgBlueprint: BlueprintJSON = {
        ...mockBlueprint,
        framework: {
          ...mockBlueprint.framework,
          framework: 'langgraph',
          langGraph: {
            detected: true,
            stateType: 'typeddict',
            estimatedStateSizeBytes: 8192,
            checkpointing: true,
            checkpointBackend: 'sqlite',
            recommendedGpuTier: 'T4',
            recommendedGpuMemoryGB: 8,
          },
        },
      };

      const code = ModalAppDeployer.generateModalApp(lgBlueprint, 'dep_lg_infer');

      expect(code).toContain('elif framework == "langgraph":');
      expect(code).toContain('self.compiled_graph.invoke');
      expect(code).toContain('SqliteSaver');
    });
  });

  describe('User project deploy path', () => {
    it('should include add_local_dir, /app, and user_runner when projectPath is set', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_proj123', {
        projectPath: '/tmp/fake-project',
      });

      expect(code).toContain('add_local_dir("project"');
      expect(code).toContain('/app');
      expect(code).toContain('user_runner');
      expect(code).toContain('_run_user_inference');
    });

    it('should include apt_install when systemPackages are non-empty', () => {
      const blueprintWithApt: BlueprintJSON = {
        ...mockBlueprint,
        systemRequirements: {
          ...mockBlueprint.systemRequirements,
          systemPackages: ['libgl1', 'ffmpeg'],
        },
      };

      const code = ModalAppDeployer.generateModalApp(blueprintWithApt, 'dep_apt123');

      expect(code).toContain('apt_install');
      expect(code).toContain('"libgl1"');
      expect(code).toContain('"ffmpeg"');
    });

    it('should not include add_local_dir when projectPath is not set', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_no_proj');

      expect(code).not.toContain('add_local_dir');
      expect(code).not.toContain('_run_user_inference');
    });

    it('should keep lazy import rule with projectPath set (KRI-17)', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_lazy_proj', {
        projectPath: '/tmp/fake-project',
      });
      const beforeClass = code.split('class AuraOpsAgent')[0];

      expect(beforeClass).toContain('import modal');
      expect(beforeClass).not.toMatch(
        /from langchain|from transformers|import torch|import tensorflow|import jax/,
      );
      expect(beforeClass).not.toContain('from typing import');
    });

    it('should include framework fallback when projectPath is set', () => {
      const code = ModalAppDeployer.generateModalApp(mockBlueprint, 'dep_fallback', {
        projectPath: '/tmp/fake-project',
      });

      expect(code).toMatch(/falling back|initialize_agent/);
      expect(code).toContain('falling back to framework scaffold');
      expect(code).toContain('from langchain.agents import initialize_agent');
    });
  });
});
