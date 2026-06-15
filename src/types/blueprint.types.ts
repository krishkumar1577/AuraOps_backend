export interface ParsedManifest {
  framework: string;
  frameworkVersion: string;
  pythonVersion: string;
  allDependencies: Record<string, string>;
  cudaVersion?: string;
  torchVersion?: string;
  langchainVersion?: string;
  systemDependencies?: string[];
  customModels?: Array<{
    name: string;
    path: string;
    hash: string;
    size: number;
  }>;
}

export type LangGraphStateType = 'dict' | 'pydantic' | 'dataclass' | 'typeddict' | 'unknown';
export type LangGraphGpuTier = 'T4' | 'L4' | 'A10G';

export interface LangGraphMetadata {
  detected: true;
  stateType: LangGraphStateType;
  stateClassName?: string;
  estimatedStateSizeBytes: number;
  checkpointing: boolean;
  checkpointBackend?: 'memory' | 'sqlite' | 'postgres' | 'redis' | 'unknown';
  recommendedGpuTier: LangGraphGpuTier;
  recommendedGpuMemoryGB: 8 | 16 | 24;
}

export interface FrameworkFingerprint {
  framework: 'pytorch' | 'langchain' | 'langgraph' | 'transformers' | 'jax' | 'tensorflow';
  version: string;
  cudaVersion: string;
  pythonVersion: string;
  primaryUse: 'inference' | 'training' | 'agentic';
  langGraph?: LangGraphMetadata;
}

export interface BlueprintJSON {
  id: string;
  timestamp: string;
  framework: FrameworkFingerprint;
  dependencyLock: Record<string, string>;
  systemRequirements: {
    pythonVersion: string;
    cudaVersion: string;
    cuDNNVersion: string;
    baseImageId: string;
    baseImageTag: string;
    systemPackages: string[];
  };
  customModels: Array<{
    name: string;
    path: string;
    hash: string;
    size: number;
  }>;
  deploymentConfig: {
    entrypoint: string;
    runtime: string;
    memoryMB: number;
    gpuRequired: boolean;
    gpuMemoryGB: number;
  };
  checksums: {
    allDepsHash: string;
    blueprintHash: string;
  };
}
