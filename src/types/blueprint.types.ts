export interface ParsedManifest {
  framework: string;
  frameworkVersion: string;
  pythonVersion: string;
  allDependencies: Record<string, string>;
  cudaVersion?: string;
  torchVersion?: string;
  langchainVersion?: string;
  customModels?: Array<{
    name: string;
    path: string;
    hash: string;
    size: number;
  }>;
}

export interface FrameworkFingerprint {
  framework: 'pytorch' | 'langchain' | 'transformers' | 'jax' | 'tensorflow';
  version: string;
  cudaVersion: string;
  pythonVersion: string;
  primaryUse: 'inference' | 'training' | 'agentic';
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
