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
}

export interface GPUAcquisitionSpec {
  minMemory: number;
  framework: string;
  region?: string;
  maxWaitSeconds?: number;
}

export interface GPUProvider {
  name: string;
  connect(credentials: Record<string, string>): Promise<void>;
  listAvailable(): Promise<GPUInstance[]>;
  acquireGPU(spec: GPUAcquisitionSpec): Promise<WorkerInstance>;
  releaseGPU(workerId: string): Promise<void>;
  getPrice(gpuType: string, region?: string): Promise<number>;
  healthCheck(): Promise<boolean>;
}
