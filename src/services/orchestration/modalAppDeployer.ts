import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../../utils/config';
import { DeploymentError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import type { BlueprintJSON } from '../../types/blueprint.types';

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
  ): string {
    try {
      // Validate and log all inputs
      if (!blueprint) throw new Error('blueprint is null/undefined');
      if (!blueprint.dependencyLock) logger.warn('generateModalApp: dependencyLock is missing');
      if (!blueprint.deploymentConfig) logger.warn('generateModalApp: deploymentConfig is missing');
      if (!blueprint.framework) logger.warn('generateModalApp: framework is missing');

      const dependencies = this.formatDependencies(blueprint.dependencyLock);
      const gpuConfig = this.selectGPU(blueprint.deploymentConfig?.gpuMemoryGB || 24);
      const loaderCode = this.generateFrameworkLoader(
        blueprint.framework?.framework || 'langchain',
        blueprint.customModels,
      );

      return `
#!/usr/bin/env python3
"""
AuraOps Modal App
Auto-generated persistent endpoint for AI agent inference.
Deployment ID: ${deploymentId}
"""

import modal
import json
from typing import Dict, Any
from pydantic import BaseModel, Field

# Initialize Modal app
app = modal.App("auraops-${deploymentId}")

# Build Docker image from dependencies
image = modal.Image.debian_slim() \\
    .pip_install([
        ${dependencies}
    ])

# Request/Response schemas
class InferenceRequest(BaseModel):
    """Inference request schema"""
    input: str = Field(..., description="Input text or prompt")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Optional metadata")

class InferenceResponse(BaseModel):
    """Inference response schema"""
    output: str
    deployment_id: str = "${deploymentId}"
    processing_time_ms: float
    metadata: Dict[str, Any] = Field(default_factory=dict)

# Agent class with persistent load
@app.cls(
    gpu="${gpuConfig}",
    image=image,
    timeout=300,
    container_idle_timeout=60,
)
class AuraOpsAgent:
    """AI Agent for inference"""

    def __init__(self):
        self.agent = None
        self.model = None
        self.tokenizer = None

    @modal.enter()
    def load(self):
        """Load model/agent on container startup"""
        import time
        start_time = time.time()
        
        try:
${loaderCode}
            load_time = time.time() - start_time
            print(f"✓ Agent loaded in {load_time:.2f}s")
        except Exception as e:
            raise RuntimeError(f"Failed to load agent: {str(e)}")

    @modal.exit()
    def cleanup(self):
        """Cleanup resources on container shutdown"""
        self.agent = None
        self.model = None
        self.tokenizer = None
        print("✓ Agent cleanup complete")

    @modal.fastapi_endpoint(method="POST")
    def endpoint(self, request: InferenceRequest) -> InferenceResponse:
        """HTTP POST endpoint for inference"""
        import time
        start_time = time.time()
        
        try:
            # Run inference based on framework
            output = self._run_inference(request.input, request.metadata)
            
            processing_time = (time.time() - start_time) * 1000  # Convert to ms
            
            return InferenceResponse(
                output=output,
                processing_time_ms=processing_time,
                metadata={"framework": "${blueprint.framework.framework}"},
            )
        except Exception as e:
            raise RuntimeError(f"Inference failed: {str(e)}")

    def _run_inference(self, input_text: str, metadata: Dict[str, Any]) -> str:
        """
        Execute inference based on framework
        """
        framework = "${blueprint.framework.framework}"
        
        if framework == "langchain":
            if self.agent is None:
                raise RuntimeError("LangChain agent not loaded")
            response = self.agent.invoke({"input": input_text})
            return response.get("output", str(response))
            
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
            
        else:
            # Custom/Ghost manifest - try to call agent
            if self.agent and hasattr(self.agent, 'infer'):
                return self.agent.infer(input_text)
            elif self.agent and hasattr(self.agent, 'run'):
                return self.agent.run(input_text)
            else:
                return f"Processed by {framework} agent"

# Health check endpoint
@app.function(image=image)
def health_check():
    """Simple health check"""
    return {"status": "healthy", "deployment_id": "${deploymentId}"}

if __name__ == "__main__":
    # This allows local testing
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
  private static formatDependencies(dependencyLock?: Record<string, string>): string {
    if (!dependencyLock || Object.keys(dependencyLock).length === 0) {
      return '"langchain", "openai"';
    }
    return Object.entries(dependencyLock)
      .map(([pkg, version]) => `"${pkg}${version ? `==${version}` : ''}"`)
      .join(', \\n        ');
  }

  /**
   * Select GPU based on memory requirement
   */
  private static selectGPU(gpuMemoryGB: number): string {
    if (gpuMemoryGB <= 8) {
      return 'modal.gpu.T4()';
    } else if (gpuMemoryGB <= 16) {
      return 'modal.gpu.L4()';
    } else if (gpuMemoryGB <= 24) {
      return 'modal.gpu.A10G()';
    } else if (gpuMemoryGB <= 40) {
      return 'modal.gpu.A100()';
    } else {
      return 'modal.gpu.A100(count=2)';
    }
  }

  /**
   * Generate framework-specific loader code for @modal.enter()
   */
  private static generateFrameworkLoader(
    framework: string,
    customModels?: Array<{ name: string; path: string }>,
  ): string {
    const indent = '            ';

    switch (framework) {
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
        // Ghost manifest / raw Python
        return `${indent}# Custom agent initialization
${indent}import importlib.util
${indent}
${indent}# Load user-defined agent from main.py if available
${indent}try:
${indent}    spec = importlib.util.spec_from_file_location("agent_module", "main.py")
${indent}    agent_module = importlib.util.module_from_spec(spec)
${indent}    spec.loader.exec_module(agent_module)
${indent}    
${indent}    if hasattr(agent_module, 'Agent'):
${indent}        self.agent = agent_module.Agent()
${indent}    elif hasattr(agent_module, 'agent'):
${indent}        self.agent = agent_module.agent
${indent}    
${indent}    print("✓ Custom agent loaded from main.py")
${indent}except FileNotFoundError:
${indent}    print("Note: main.py not found, using default agent")
${indent}    self.agent = type('Agent', (), {
${indent}        'infer': lambda self, x: f"Default response to: {x}"
${indent}    })()`;
    }
  }

  /**
   * Write modal_app.py to temporary directory with unique name
   */
  static async writeModalApp(
    content: string,
    deploymentId: string,
  ): Promise<string> {
    const tmpDir = path.join('/tmp', `auraops-${deploymentId}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const appPath = path.join(tmpDir, `modal_app_${deploymentId}.py`);
    await fs.writeFile(appPath, content, 'utf-8');

    logger.info(`Modal app written to ${appPath}`);
    return appPath;
  }

  /**
   * Deploy Modal app and capture live HTTPS endpoint URL
   */
  static async deployApp(appPath: string, deploymentId: string): Promise<string> {
    const start = Date.now();

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      logger.info(`Deploying Modal app from ${appPath}`);

      // Set 120s timeout
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        logger.error('Modal deploy timeout after 120s');
        reject(
          new DeploymentError('Modal deployment timeout after 120s', {
            deploymentId,
            stdout,
            stderr,
          }),
        );
      }, 120000);

      // Pass Modal auth tokens and inherited env to child process
      const proc = spawn('modal', ['deploy', appPath], {
        cwd: path.dirname(appPath),
        stdio: 'pipe',
        env: {
          ...process.env,
          MODAL_TOKEN_ID: config.modal_token_id,
          MODAL_TOKEN_SECRET: config.modal_token_secret,
        },
      });

      proc.stdout!.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        logger.debug(`Modal deploy stdout: ${chunk}`);
      });

      proc.stderr!.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        logger.debug(`Modal deploy stderr: ${chunk}`);
      });

      proc.on('close', (code: number) => {
        if (timedOut) return;
        clearTimeout(timeout);

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

        // Extract HTTPS URL from Modal deploy output
        // Format: "https://{workspace}--auraops-{id}.modal.run"
        const urlMatch = stdout.match(/https:\/\/[\w-]+--auraops-[\w-]+\.modal\.run/);
        if (!urlMatch) {
          logger.warn(
            `Could not find HTTPS URL in Modal output. Full output:\n${stdout}`,
          );
          reject(
            new DeploymentError('Modal: Could not extract endpoint URL', {
              deploymentId,
              output: stdout,
            }),
          );
          return;
        }

        const endpointUrl = urlMatch[0];
        logger.info(`✓ Modal app deployed in ${deployTime}ms: ${endpointUrl}`);
        resolve(endpointUrl);
      });

      proc.on('error', (error: Error) => {
        if (timedOut) return;
        clearTimeout(timeout);

        logger.error(`Modal deploy process error: ${error.message}`);
        reject(
          new DeploymentError('Modal deployment process error', {
            deploymentId,
            cause: error.message,
          }),
        );
      });
    });
  }

  /**
   * Stop a Modal app deployment
   */
  static async stopApp(deploymentId: string): Promise<void> {
    const start = Date.now();

    return new Promise((resolve) => {
      logger.info(`Stopping Modal app: auraops-${deploymentId}`);

      const proc = spawn('modal', ['app', 'stop', `auraops-${deploymentId}`]);

      proc.on('close', (code: number) => {
        if (code !== 0) {
          logger.warn(`Modal app stop returned code ${code}`);
          // Don't reject - app may already be stopped
        }

        const stopTime = Date.now() - start;
        logger.info(`✓ Modal app stopped in ${stopTime}ms: auraops-${deploymentId}`);
        resolve();
      });

      proc.on('error', (error: Error) => {
        logger.warn(`Modal app stop error: ${error.message}`);
        // Don't reject - best effort
        resolve();
      });

      // Timeout after 30s
      setTimeout(() => {
        proc.kill();
        logger.warn(`Modal app stop timeout: auraops-${deploymentId}`);
        resolve();
      }, 30_000);
    });
  }
}
