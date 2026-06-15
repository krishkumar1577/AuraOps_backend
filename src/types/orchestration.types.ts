export interface GPUInstance {
  id: string;
  gpuType: string;
  memoryGB: number;
  available: boolean;
  region?: string;
  pricePerHour?: number;
}

export interface WorkerInstance {
  workerId: string;
  gpuId: string;
  ipAddress: string;
  port: number;
  gpuType: string;
  memoryGB: number;
  framework: string;
  status: 'provisioning' | 'ready' | 'deployed';
  secureRuntimeActive: boolean;
}

export interface GPUAcquisitionSpec {
  minMemory: number;
  framework: string;
  region?: string;
  maxWaitSeconds?: number;
  secureRuntime?: boolean;
  /** Number of GPUs to allocate (1-8, default 1). */
  gpuCount?: number;
}

export interface GPUProvider {
  name: string;
  connect(credentials: Record<string, string>): Promise<void>;
  listAvailable(): Promise<GPUInstance[]>;
  acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance>;
  releaseGPU(workerId: string): Promise<void>;
  getPrice(gpuType: string, region?: string): Promise<number>;
  healthCheck(): Promise<boolean>;
  getGpuUtilization(workerId: string): Promise<number | null>;
}
