import type { CachedWeight } from './redisClient';

export interface DockerVolumeMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface K8sVolumeMount {
  name: string;
  mountPath: string;
  readOnly: boolean;
}

export interface K8sVolume {
  name: string;
  hostPath: {
    path: string;
    type: 'Directory' | 'File';
  };
}

export class VolumeMounter {
  generateDockerMounts(weights: CachedWeight[]): string {
    return weights
      .map(weight => `-v ${weight.storagePath}:${weight.mountPoint}:ro`)
      .join(' ');
  }

  generateK8sMounts(weights: CachedWeight[]): K8sVolumeMount[] {
    return weights.map(weight => ({
      name: this.sanitizeK8sName(weight.modelHash),
      mountPath: weight.mountPoint,
      readOnly: true,
    }));
  }

  generateK8sVolumes(weights: CachedWeight[]): K8sVolume[] {
    return weights.map(weight => ({
      name: this.sanitizeK8sName(weight.modelHash),
      hostPath: {
        path: weight.storagePath,
        type: 'Directory',
      },
    }));
  }

  private sanitizeK8sName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 253);
  }
}
