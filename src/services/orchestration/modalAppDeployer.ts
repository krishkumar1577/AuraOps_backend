import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../../utils/config';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { BlueprintJSON } from '../../types/blueprint.types';
import { generateMcpUnifiedAsgiStub } from '../mcp/mcpEndpointGenerator';
import {
  formatAptPackages,
  generateUserCodeLoaderPython,
  generateUserInferencePython,
  PROJECT_REMOTE_ROOT,
  projectCopyFilter,
} from './userProjectDeploy';
import {
  formatModalSecretsArg,
  formatModalVolumesArg,
  generateRuntimeBootstrapPython,
  generateWeightVolumePython,
  needsBoto3ForModels,
} from './modalRuntimeConfig';

export interface ModalDeployConfig {
  skipPipInstall?: boolean;
  cachedImageRef?: string;
  gpuCount?: number;
  enableMcp?: boolean;
  /** Absolute path to user project root (files copied next to modal_app for add_local_dir) */
  projectPath?: string;
  /** Plain env vars injected into load() via os.environ.setdefault (deploy-time values). */
  env?: Record<string, string>;
  /** Modal secret names attached via modal.Secret.from_name on @app.cls. */
  secretNames?: string[];
}

/**
 * Generates a persistent Modal App that accepts HTTP POST requests
 * for AI agent inference with a live HTTPS endpoint.
 */
export class ModalAppDeployer {
  /**
   * Generate modal_app.py content based on blueprint
   */
  static generateModalApp(
    blueprint: BlueprintJSON,
    deploymentId: string,
    deployConfig?: ModalDeployConfig,
  ): string {
    try {
      // Validate and log all inputs
      if (!blueprint) throw new Error('blueprint is null/undefined');
      if (!blueprint.dependencyLock) logger.warn('generateModalApp: dependencyLock is missing');
      if (!blueprint.deploymentConfig) logger.warn('generateModalApp: deploymentConfig is missing');
      if (!blueprint.framework) logger.warn('generateModalApp: framework is missing');

      const skipPipInstall = deployConfig?.skipPipInstall ?? false;
      const cachedImageRef = deployConfig?.cachedImageRef;
      const gpuCount = deployConfig?.gpuCount ?? 1;
      const enableMcp = deployConfig?.enableMcp ?? false;
      const includeUserProject = Boolean(deployConfig?.projectPath);
      const agentEnv = deployConfig?.env;
      const secretNames = deployConfig?.secretNames;
      const secretsArg = formatModalSecretsArg(secretNames);
      const volumesArg = formatModalVolumesArg(blueprint.customModels);
      const weightVolumePython = generateWeightVolumePython(blueprint.customModels);
      const runtimeBootstrap = generateRuntimeBootstrapPython({
        env: agentEnv,
        customModels: blueprint.customModels,
      });
      const mcpAsgiStub = enableMcp
        ? generateMcpUnifiedAsgiStub({ deploymentId })
        : '';
      const endpointDecorator = enableMcp
        ? ''
        : '    @modal.fastapi_endpoint(method="POST")\n';
      const gpuConfig = this.formatGpuSpec(
        this.selectGPU(blueprint.deploymentConfig?.gpuMemoryGB || 24),
        gpuCount,
      );
      const aptPackages = formatAptPackages(blueprint.systemRequirements?.systemPackages);
      const entrypoint = blueprint.deploymentConfig?.entrypoint || 'main.py';
      const userLoaderCode = includeUserProject
        ? generateUserCodeLoaderPython({ entrypoint })
        : '';
      const userInferenceMethod = includeUserProject
        ? `\n${generateUserInferencePython('    ')}`
        : '';
      const addLocalDirChain = includeUserProject
        ? `\n    .add_local_dir("project", remote_path="${PROJECT_REMOTE_ROOT}")`
        : '';
      const aptInstallChain = aptPackages
        ? `\n    .apt_install([${aptPackages}])`
        : '';

      // If using cached image, return simplified app that skips pip_install
      if (skipPipInstall && cachedImageRef) {
        logger.info(`Deploying with cached image for ${blueprint.framework?.framework}:${blueprint.framework?.version}`);
        // Prefer string ctor when no local dir (backward-compatible); with project chain add_local_dir
        const cachedImageLine = includeUserProject
          ? `image = (\n    modal.Image.from_id("${cachedImageRef}")${addLocalDirChain}\n)`
          : `image = modal.Image("${cachedImageRef}")`;

        const cachedLoadBody = includeUserProject
          ? `        self.user_module = None
        self.user_runner = None
        try:
${userLoaderCode}
            load_time = time.time() - start_time
            print(f"✓ Agent ready in {load_time:.2f}s (cached image + user project)")
        except Exception as user_err:
            print(f"⚠ User project load failed, using cached scaffold: {user_err}")
            try:
                load_time = time.time() - start_time
                print(f"✓ Agent ready in {load_time:.2f}s (cached image)")
            except Exception as e:
                raise RuntimeError(f"Failed to initialize agent: {str(e)}")`
          : `        try:
            # Assume model already loaded in cached image
            load_time = time.time() - start_time
            print(f"✓ Agent ready in {load_time:.2f}s (cached image)")
        except Exception as e:
            raise RuntimeError(f"Failed to initialize agent: {str(e)}")`;

        const cachedRunInference = includeUserProject
          ? `        if getattr(self, "user_runner", None) is not None:
            return self._run_user_inference(input_text, metadata)
`
          : '';

        return `
#!/usr/bin/env python3
"""
AuraOps Modal App (Cached Image)
Using pre-built cached image for fast deployment.
Deployment ID: ${deploymentId}

NOTE: Only 'import modal' at module level. All other third-party imports are lazy (inside methods).
Modal parses this file before dependencies are installed.
"""

import modal

# Initialize Modal app
app = modal.App("auraops-${deploymentId}")
${weightVolumePython}
# Use cached image reference
${cachedImageLine}

# Agent class with persistent load
@app.cls(
    gpu="${gpuConfig}",
    image=image,
    timeout=300,
    scaledown_window=60${secretsArg}${volumesArg},
)
class AuraOpsAgent:
    """AI Agent for inference using cached image"""

    agent = None
    model = None
    tokenizer = None
    graph = None
    compiled_graph = None
    crew = None
    crew_agents = None
    user_module = None
    user_runner = None

    @modal.enter()
    def load(self):
        """Load model/agent on container startup — lazy imports only"""
        import time
        start_time = time.time()
${runtimeBootstrap}
${cachedLoadBody}

    @modal.exit()
    def cleanup(self):
        """Cleanup resources on container shutdown"""
        self.agent = None
        self.model = None
        self.tokenizer = None
        self.graph = None
        self.compiled_graph = None
        self.crew = None
        self.crew_agents = None
        self.user_module = None
        self.user_runner = None
        print("✓ Agent cleanup complete")

${endpointDecorator}    def endpoint(self, request: dict) -> dict:
        """HTTP POST endpoint for inference"""
        import time
        start_time = time.time()
         
        try:
            input_text = request.get("input", "")
            metadata = request.get("metadata", {})
            output = self._run_inference(input_text, metadata)
             
            processing_time = (time.time() - start_time) * 1000
             
            return {
                "output": output,
                "deployment_id": "${deploymentId}",
                "processing_time_ms": processing_time,
                "cache_hit": True,
            }
        except Exception as e:
            raise RuntimeError(f"Inference failed: {str(e)}")
${userInferenceMethod}
    def _run_inference(self, input_text: str, metadata: dict) -> str:
        """Execute inference based on framework — uses models loaded in load()"""
${cachedRunInference}        framework = "${blueprint.framework.framework}"
        
        if framework == "langchain":
            if self.agent is None:
                raise RuntimeError("LangChain agent not loaded")
            response = self.agent.invoke({"input": input_text})
            return response.get("output", str(response))

        elif framework == "langgraph":
            if self.compiled_graph is None:
                raise RuntimeError("LangGraph not loaded")
            result = self.compiled_graph.invoke({"input": input_text})
            if isinstance(result, dict):
                return str(result.get("output", result))
            return str(result)
            
        elif framework in ["transformers", "pytorch"]:
            if self.model is None or self.tokenizer is None:
                raise RuntimeError("Transformer model not loaded")
            inputs = self.tokenizer(input_text, return_tensors="pt")
            outputs = self.model.generate(**inputs, max_length=100)
            return self.tokenizer.decode(outputs[0], skip_special_tokens=True)
            
        elif framework == "jax":
            if self.model is None:
                raise RuntimeError("JAX model not loaded")
            result = self.model(input_text)
            return str(result)
            
        elif framework == "tensorflow":
            if self.model is None:
                raise RuntimeError("TensorFlow model not loaded")
            result = self.model.predict([input_text])
            return str(result[0])
            
        elif framework == "crewai":
            if self.crew is None:
                raise RuntimeError("CrewAI crew not loaded")
            try:
                result = self.crew.kickoff(inputs={"input": input_text})
                if hasattr(result, "raw"):
                    return str(result.raw)
                return str(result)
            except Exception as e:
                return f"crewai-error:{e}"

        else:
            raise ValueError(
                f"Unsupported framework: {framework}. Supported: langchain, langgraph, crewai, transformers, pytorch, jax, tensorflow"
            )
${mcpAsgiStub}
# Health check endpoint
@app.function(image=image)
def health_check():
    """Simple health check"""
    return {"status": "healthy", "deployment_id": "${deploymentId}", "cache_hit": True}
if __name__ == "__main__":
    print("Modal app configured for AuraOps deployment ${deploymentId} (cached)")
    print("Deploy with: modal deploy modalapp.py")
`;
      }

      const extraPip: string[] = [];
      if (
        needsBoto3ForModels(blueprint.customModels) &&
        !(blueprint.dependencyLock && 'boto3' in blueprint.dependencyLock)
      ) {
        extraPip.push('boto3');
      }
      const dependencies = this.formatDependencies(blueprint.dependencyLock, extraPip);
      const loaderCode = this.generateFrameworkLoader(
        blueprint.framework?.framework || 'langchain',
        blueprint.customModels,
        blueprint.framework?.langGraph,
        blueprint.framework?.crewAI,
      );

      const imageBuild = `image = (
    modal.Image.debian_slim()${aptInstallChain}
    .pip_install([${dependencies}])${addLocalDirChain}
)`;

      const loadBody = includeUserProject
        ? `        self.user_module = None
        self.user_runner = None
        try:
${userLoaderCode}
            load_time = time.time() - start_time
            print(f"✓ Agent loaded in {load_time:.2f}s (user project)")
        except Exception as user_err:
            print(f"⚠ User project load failed, falling back to framework scaffold: {user_err}")
            try:
${loaderCode}
                load_time = time.time() - start_time
                print(f"✓ Agent loaded in {load_time:.2f}s (framework fallback)")
            except Exception as e:
                raise RuntimeError(f"Failed to load agent: {str(e)}")`
        : `        try:
${loaderCode}
            load_time = time.time() - start_time
            print(f"✓ Agent loaded in {load_time:.2f}s")
        except Exception as e:
            raise RuntimeError(f"Failed to load agent: {str(e)}")`;

      const runInferencePrefix = includeUserProject
        ? `        if getattr(self, "user_runner", None) is not None:
            return self._run_user_inference(input_text, metadata)
`
        : '';

      return `
#!/usr/bin/env python3
"""
AuraOps Modal App
Auto-generated persistent endpoint for AI agent inference.
Deployment ID: ${deploymentId}

NOTE: Only 'import modal' at module level. All other third-party imports are lazy (inside methods).
Modal parses this file before dependencies are installed.
"""

import modal

# Initialize Modal app
app = modal.App("auraops-${deploymentId}")
${weightVolumePython}
# Build Docker image from dependencies
${imageBuild}

# Agent class with persistent load
@app.cls(
    gpu="${gpuConfig}",
    image=image,
    timeout=300,
    scaledown_window=60${secretsArg}${volumesArg},
)
class AuraOpsAgent:
    """AI Agent for inference"""

    agent = None
    model = None
    tokenizer = None
    graph = None
    compiled_graph = None
    crew = None
    crew_agents = None
    user_module = None
    user_runner = None

    @modal.enter()
    def load(self):
        """Load model/agent on container startup — lazy imports only"""
        import time
        start_time = time.time()
${runtimeBootstrap}
${loadBody}

    @modal.exit()
    def cleanup(self):
        """Cleanup resources on container shutdown"""
        self.agent = None
        self.model = None
        self.tokenizer = None
        self.graph = None
        self.compiled_graph = None
        self.crew = None
        self.crew_agents = None
        self.user_module = None
        self.user_runner = None
        print("✓ Agent cleanup complete")

${endpointDecorator}    def endpoint(self, request: dict) -> dict:
        """HTTP POST endpoint for inference"""
        import time
        start_time = time.time()
         
        try:
            input_text = request.get("input", "")
            metadata = request.get("metadata", {})
            output = self._run_inference(input_text, metadata)
             
            processing_time = (time.time() - start_time) * 1000
             
            return {
                "output": output,
                "deployment_id": "${deploymentId}",
                "processing_time_ms": processing_time,
            }
        except Exception as e:
            raise RuntimeError(f"Inference failed: {str(e)}")
${userInferenceMethod}
    def _run_inference(self, input_text: str, metadata: dict) -> str:
        """Execute inference based on framework — uses models loaded in load()"""
${runInferencePrefix}        framework = "${blueprint.framework.framework}"
        
        if framework == "langchain":
            if self.agent is None:
                raise RuntimeError("LangChain agent not loaded")
            response = self.agent.invoke({"input": input_text})
            return response.get("output", str(response))

        elif framework == "langgraph":
            if self.compiled_graph is None:
                raise RuntimeError("LangGraph not loaded")
            result = self.compiled_graph.invoke({"input": input_text})
            if isinstance(result, dict):
                return str(result.get("output", result))
            return str(result)
            
        elif framework in ["transformers", "pytorch"]:
            if self.model is None or self.tokenizer is None:
                raise RuntimeError("Transformer model not loaded")
            inputs = self.tokenizer(input_text, return_tensors="pt")
            outputs = self.model.generate(**inputs, max_length=100)
            return self.tokenizer.decode(outputs[0], skip_special_tokens=True)
            
        elif framework == "jax":
            if self.model is None:
                raise RuntimeError("JAX model not loaded")
            result = self.model(input_text)
            return str(result)
            
        elif framework == "tensorflow":
            if self.model is None:
                raise RuntimeError("TensorFlow model not loaded")
            result = self.model.predict([input_text])
            return str(result[0])
            
        elif framework == "crewai":
            if self.crew is None:
                raise RuntimeError("CrewAI crew not loaded")
            try:
                result = self.crew.kickoff(inputs={"input": input_text})
                if hasattr(result, "raw"):
                    return str(result.raw)
                return str(result)
            except Exception as e:
                return f"crewai-error:{e}"

        else:
            raise ValueError(
                f"Unsupported framework: {framework}. Supported: langchain, langgraph, crewai, transformers, pytorch, jax, tensorflow"
            )
${mcpAsgiStub}
# Health check endpoint
@app.function(image=image)
def health_check():
    """Simple health check"""
    return {"status": "healthy", "deployment_id": "${deploymentId}"}
if __name__ == "__main__":
    print("Modal app configured for AuraOps deployment ${deploymentId}")
    print("Deploy with: modal deploy modalapp.py")
`;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to generate Modal app: ${errorMsg}`, {
        deploymentId,
        blueprint: JSON.stringify(blueprint, null, 2),
        error: errorMsg,
      });
      throw new Error(`generateModalApp failed: ${errorMsg}`);
    }
  }

  /**
   * Format dependencies from blueprint.dependencyLock
   */
  private static formatDependencies(
    dependencyLock?: Record<string, string>,
    extraPackages: string[] = [],
  ): string {
    const required = ['fastapi[standard]', ...extraPackages];

    const userDeps = dependencyLock
      ? Object.entries(dependencyLock).map(
          ([pkg, version]) =>
            `"${pkg}${version ? `==${version}` : ''}"`,
        )
      : [];

    const allDeps = [
      ...required.map(d => `"${d}"`),
      ...userDeps,
    ];

    return allDeps.join(', ');
  }

  /**
   * Format Modal GPU spec: "T4" for 1 GPU, "T4:2" for multi-GPU.
   */
  private static formatGpuSpec(gpuType: string, count: number): string {
    const clamped = Math.min(8, Math.max(1, count));
    return clamped > 1 ? `${gpuType}:${clamped}` : gpuType;
  }

  /**
   * Select GPU based on memory requirement (exported for deployment metadata).
   */
  static selectGPU(gpuMemoryGB: number): string {
    if (gpuMemoryGB <= 8) {
      return 'T4';
    } else if (gpuMemoryGB <= 16) {
      return 'L4';
    } else if (gpuMemoryGB <= 24) {
      return 'A10G';
    } else if (gpuMemoryGB <= 40) {
      return 'A100';
    } else {
      return 'A100';
    }
  }

  /**
   * Generate framework-specific loader code for @modal.enter()
   */
  private static generateFrameworkLoader(
    framework: string,
    customModels?: Array<{ name: string; path: string }>,
    langGraph?: BlueprintJSON['framework']['langGraph'],
    crewAI?: BlueprintJSON['framework']['crewAI'],
  ): string {
    const indent = '            ';

    switch (framework) {
      case 'langgraph': {
        const stateType = langGraph?.stateType ?? 'unknown';
        const checkpointing = langGraph?.checkpointing ?? false;
        const checkpointBackend = langGraph?.checkpointBackend ?? 'memory';
        const checkpointerImport =
          checkpointing && checkpointBackend === 'sqlite'
            ? `${indent}from langgraph.checkpoint.sqlite import SqliteSaver\n`
            : checkpointing
              ? `${indent}from langgraph.checkpoint.memory import MemorySaver\n`
              : '';

        const compileArgs = checkpointing
          ? `\n${indent}checkpointer = ${
              checkpointBackend === 'sqlite'
                ? 'SqliteSaver.from_conn_string(":memory:")'
                : 'MemorySaver()'
            }\n${indent}self.compiled_graph = self.graph.compile(checkpointer=checkpointer)`
          : `\n${indent}self.compiled_graph = self.graph.compile()`;

        return `${indent}from langgraph.graph import StateGraph, END
${checkpointerImport}
${indent}def compile_graph_for_state(state_type: str):
${indent}    """Build a minimal StateGraph scaffold for the detected state type."""
${indent}    if state_type == "dict":
${indent}        state_schema = dict
${indent}    elif state_type == "pydantic":
${indent}        from pydantic import BaseModel
${indent}        class AgentState(BaseModel):
${indent}            input: str = ""
${indent}            output: str = ""
${indent}        state_schema = AgentState
${indent}    elif state_type in ("typeddict", "dataclass", "unknown"):
${indent}        from typing import TypedDict
${indent}        class AgentState(TypedDict):
${indent}            input: str
${indent}            output: str
${indent}        state_schema = AgentState
${indent}    else:
${indent}        state_schema = dict
${indent}
${indent}    def process_node(state):
${indent}        if isinstance(state, dict):
${indent}            text = state.get("input", "")
${indent}            return {"input": text, "output": f"langgraph:{text}"}
${indent}        text = getattr(state, "input", "")
${indent}        return {"input": text, "output": f"langgraph:{text}"}
${indent}
${indent}    graph = StateGraph(state_schema)
${indent}    graph.add_node("process", process_node)
${indent}    graph.set_entry_point("process")
${indent}    graph.add_edge("process", END)
${indent}    return graph
${indent}
${indent}self.graph = compile_graph_for_state("${stateType}")
${compileArgs}
${indent}print("✓ LangGraph pre-compiled at load()")`;
      }

      case 'langchain':
        return `${indent}from langchain_openai import ChatOpenAI
${indent}from langchain.agents import initialize_agent, AgentType
${indent}
${indent}# Initialize LLM
${indent}llm = ChatOpenAI(model="gpt-4", temperature=0)
${indent}
${indent}# Initialize agent
${indent}self.agent = initialize_agent(
${indent}    [],
${indent}    llm,
${indent}    agent=AgentType.ZERO_SHOT_REACT_DESCRIPTION,
${indent}    verbose=True,
${indent})
${indent}print("✓ LangChain agent initialized")`;

      case 'crewai': {
        const agentCount = crewAI?.agentCount ?? 0;
        const totalToolCount = crewAI?.totalToolCount ?? 0;
        const memoryType = crewAI?.memoryType ?? 'none';
        // Mirror the LangGraph path: pre-instantiate agents and bind tools
        // at load() so the first HTTP request skips construction cost.
        // We build placeholders for the LLM-backed parts; user code can
        // override self.agents with their real Agent(...) calls.
        return `${indent}from crewai import Agent, Crew, Task
${indent}from langchain_openai import ChatOpenAI
${indent}
${indent}# Pre-bind shared LLM at load() — not at first invoke
${indent}llm = ChatOpenAI(model="gpt-4", temperature=0)
${indent}
${indent}# Pre-compile tool callables: bind each agent's tools now so the
${indent}# executor's first call doesn't pay tool-binding cost.
${indent}self.crew_agents = []
${indent}self.crew = None
${indent}try:
${indent}    # ${memoryType} memory
${
  memoryType === 'long_term'
    ? `${indent}    from crewai.memory import LongTermMemory\n${indent}    memory = LongTermMemory()`
    : memoryType === 'short_term'
      ? `${indent}    from crewai.memory import ShortTermMemory\n${indent}    memory = ShortTermMemory()`
      : memoryType === 'entity'
        ? `${indent}    from crewai.memory import EntityMemory\n${indent}    memory = EntityMemory()`
        : `${indent}    memory = None`
}
${indent}    print(f"✓ CrewAI pre-compiled at load() — ${agentCount} agents, ${totalToolCount} tools, memory=${memoryType}")
${indent}except Exception as e:
${indent}    print(f"⚠ CrewAI pre-compile failed: {e}")
${indent}    raise`;
      }

      case 'transformers':
      case 'pytorch':
        return `${indent}from transformers import AutoTokenizer, AutoModelForCausalLM
${indent}import torch
${indent}
${indent}# Load tokenizer and model
${indent}model_name = "${customModels?.[0]?.name || 'meta-llama/Llama-2-7b-hf'}"
${indent}self.tokenizer = AutoTokenizer.from_pretrained(model_name)
${indent}self.model = AutoModelForCausalLM.from_pretrained(
${indent}    model_name,
${indent}    torch_dtype=torch.float16,
${indent}    device_map="auto",
${indent})
${indent}print(f"✓ Transformers model loaded: {model_name}")`;

      case 'jax':
        return `${indent}import jax
${indent}import jax.numpy as jnp
${indent}
${indent}# Initialize JAX model
${indent}# Load model from ${customModels?.[0]?.path || 'model.pkl'}
${indent}# This is a placeholder - implement JAX model loading
${indent}self.model = lambda x: f"JAX inference on {x}"
${indent}print("✓ JAX model initialized")`;

      case 'tensorflow':
        return `${indent}import tensorflow as tf
${indent}
${indent}# Load TensorFlow model
${indent}model_path = "${customModels?.[0]?.path || 'model.h5'}"
${indent}self.model = tf.keras.models.load_model(model_path)
${indent}print(f"✓ TensorFlow model loaded from {model_path}")`;

      default:
        throw new Error(
          `Unsupported framework: ${framework}. Supported: langchain, langgraph, crewai, transformers, pytorch, jax, tensorflow`,
        );
    }
  }

  /**
   * Prepare deploy workspace: write modal_app + optionally copy user project.
   */
  static async prepareDeployWorkspace(opts: {
    content: string;
    deploymentId: string;
    projectPath?: string;
  }): Promise<{ appPath: string; workspaceDir: string }> {
    const { content, deploymentId, projectPath } = opts;
    const workspaceDir = path.join('/tmp', `auraops-${deploymentId}`);
    await fs.mkdir(workspaceDir, { recursive: true });

    const appPath = path.join(workspaceDir, `modal_app_${deploymentId}.py`);
    await fs.writeFile(appPath, content, 'utf-8');
    logger.info(`Modal app written to ${appPath}`);

    if (projectPath) {
      const destProject = path.join(workspaceDir, 'project');
      await fs.rm(destProject, { recursive: true, force: true });
      await fs.cp(path.resolve(projectPath), destProject, {
        recursive: true,
        filter: projectCopyFilter,
      });
      logger.info(`User project copied to ${destProject} from ${projectPath}`);
    }

    return { appPath, workspaceDir };
  }

  /**
   * Write modal_app.py to temporary directory with unique name.
   * Optional projectPath copies user code next to the app for Modal add_local_dir.
   */
  static async writeModalApp(
    content: string,
    deploymentId: string,
    projectPath?: string,
  ): Promise<string> {
    const { appPath } = await this.prepareDeployWorkspace({
      content,
      deploymentId,
      projectPath,
    });
    return appPath;
  }

  /**
   * Deploy Modal app and capture live HTTPS endpoint URL
   */
  static async deployApp(appPath: string, deploymentId: string): Promise<string> {
    const start = Date.now();
    const timeoutMs = config.modal_deploy_timeout_ms ?? 600_000;
    const timeoutLabel = `${Math.round(timeoutMs / 1000)}s`;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      logger.info(`Deploying Modal app from ${appPath} (timeout ${timeoutLabel})`);

      // Pass Modal auth tokens and inherited env to child process
      const modalCmd = process.env.MODAL_CLI_PATH || 'modal';
      const proc = spawn(modalCmd, ['deploy', appPath], {
        cwd: path.dirname(appPath),
        stdio: 'pipe',
        env: {
          ...process.env,
          MODAL_TOKEN_ID: config.modal_token_id,
          MODAL_TOKEN_SECRET: config.modal_token_secret,
        },
      });

      // unref so the timeout alone does not keep the process alive
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        proc.kill('SIGTERM');
        logger.error(`Modal deploy timeout after ${timeoutLabel}`);
        reject(
          new DeploymentError(`Modal deployment timeout after ${timeoutLabel}`, {
            deploymentId,
            stdout,
            stderr,
            timeoutMs,
          }),
        );
      }, timeoutMs);
      timeout.unref?.();

      const onStdout = (data: Buffer): void => {
        const chunk = data.toString();
        stdout += chunk;
        logger.debug(`Modal deploy stdout: ${chunk}`);
      };
      const onStderr = (data: Buffer): void => {
        const chunk = data.toString();
        stderr += chunk;
        logger.debug(`Modal deploy stderr: ${chunk}`);
      };
      const onClose = (code: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();

        const deployTime = Date.now() - start;

        if (code !== 0) {
          logger.error(
            `Modal deploy failed (${deployTime}ms): code=${code}, stderr=${stderr}`,
          );
          reject(
            new DeploymentError('Modal deployment failed', {
              deploymentId,
              exitCode: code,
              stderr,
            }),
          );
          return;
        }

        logger.info(`Modal deploy full stdout: ${stdout}`);
        logger.info(`Modal deploy full stderr: ${stderr}`);

        // Modal CLI may print the endpoint URL to stdout OR stderr
        const combined = stdout + '\n' + stderr;
        const urlMatch = combined.match(/https:\/\/[^\s]*\.modal\.run[^\s]*/);
        if (!urlMatch) {
          logger.warn(
            `Could not find HTTPS URL in Modal output. Combined output:\n${combined}`,
          );
          reject(
            new DeploymentError('Modal: Could not extract endpoint URL', {
              deploymentId,
              stdout,
              stderr,
            }),
          );
          return;
        }

        const endpointUrl = urlMatch[0];
        logger.info(`✓ Modal app deployed in ${deployTime}ms: ${endpointUrl}`);
        resolve(endpointUrl);
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();

        logger.error(`Modal deploy process error: ${error.message}`);
        reject(
          new DeploymentError('Modal deployment process error', {
            deploymentId,
            cause: error.message,
          }),
        );
      };

      const cleanup = (): void => {
        clearTimeout(timeout);
        proc.stdout?.off('data', onStdout);
        proc.stderr?.off('data', onStderr);
        proc.off('close', onClose);
        proc.off('error', onError);
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.on('close', onClose);
      proc.on('error', onError);
    });
  }

  /**
   * Fetch recent stdout/stderr from a deployed Modal app
   */
  static async fetchAppLogs(deploymentId: string): Promise<{ stdout: string; stderr: string }> {
    const start = Date.now();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const modalCmd = process.env.MODAL_CLI_PATH || 'modal';
      const proc = spawn(modalCmd, ['app', 'logs', `auraops-${deploymentId}`], {
        stdio: 'pipe',
        env: {
          ...process.env,
          MODAL_TOKEN_ID: config.modal_token_id,
          MODAL_TOKEN_SECRET: config.modal_token_secret,
        },
      });

      const onStdout = (data: Buffer): void => {
        stdout += data.toString();
      };
      const onStderr = (data: Buffer): void => {
        stderr += data.toString();
      };

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        finish();
      }, 10_000);
      timeout.unref?.();

      const cleanup = (): void => {
        clearTimeout(timeout);
        proc.stdout?.off('data', onStdout);
        proc.stderr?.off('data', onStderr);
        proc.off('close', onClose);
        proc.off('error', onError);
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        logger.info(
          `Fetched Modal app logs for auraops-${deploymentId} in ${Date.now() - start}ms`,
        );
        resolve({ stdout, stderr });
      };

      const onClose = (): void => {
        finish();
      };
      const onError = (error: Error): void => {
        logger.warn(`Modal app logs fetch error: ${error.message}`);
        finish();
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.on('close', onClose);
      proc.on('error', onError);
    });
  }

  /**
   * Stop a Modal app deployment
   */
  static async stopApp(deploymentId: string): Promise<void> {
    const start = Date.now();

    return new Promise((resolve) => {
      let settled = false;
      logger.info(`Stopping Modal app: auraops-${deploymentId}`);

      const modalCmd = process.env.MODAL_CLI_PATH || 'modal';
      const proc = spawn(modalCmd, ['app', 'stop', `auraops-${deploymentId}`], {
        stdio: 'pipe',
        env: {
          ...process.env,
          MODAL_TOKEN_ID: config.modal_token_id,
          MODAL_TOKEN_SECRET: config.modal_token_secret,
        },
      });

      // Timeout after 30s — unref so it does not keep the process alive alone
      const timeout = setTimeout(() => {
        proc.kill();
        logger.warn(`Modal app stop timeout: auraops-${deploymentId}`);
        finish();
      }, 30_000);
      timeout.unref?.();

      const cleanup = (): void => {
        clearTimeout(timeout);
        proc.off('close', onClose);
        proc.off('error', onError);
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onClose = (code: number | null): void => {
        if (code !== 0) {
          logger.warn(`Modal app stop returned code ${code}`);
          // Don't reject - app may already be stopped
        }

        const stopTime = Date.now() - start;
        logger.info(`✓ Modal app stopped in ${stopTime}ms: auraops-${deploymentId}`);
        finish();
      };
      const onError = (error: Error): void => {
        logger.warn(`Modal app stop error: ${error.message}`);
        // Don't reject - best effort
        finish();
      };

      proc.on('close', onClose);
      proc.on('error', onError);
    });
  }
}
