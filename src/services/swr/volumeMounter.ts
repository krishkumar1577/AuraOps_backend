import type { CachedWeight } from './redisClient';
import { ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';

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

export interface DockerComposeVolumeConfig {
  driver: string;
  driver_opts?: Record<string, string>;
  labels?: Record<string, string>;
}

/**
 * VolumeMounter - Generate volume mount configurations for Docker, Kubernetes, and Docker Compose
 *
 * Generates standardized mount configurations from cached weights for different orchestration platforms.
 * Supports Docker (-v flags), Kubernetes volumeMounts/volumes, and Docker Compose volume definitions.
 *
 * @example
 * const mounter = new VolumeMounter();
 * const dockerMounts = mounter.generateDockerMounts(weights);
 * // Returns: "-v /path/to/model:/models/pytorch/model:ro"
 *
 * const k8sMounts = mounter.generateK8sMounts(weights);
 * // Returns: [{name: "model-hash", mountPath: "/models/pytorch/model", readOnly: true}]
 */
export class VolumeMounter {
  /**
   * Generate Docker volume mount flags (-v format)
   *
   * @param weights Array of cached weights to mount
   * @returns Space-separated Docker -v flags for use in docker run command
   * @throws {ValidationError} If weights array is invalid
   *
   * @example
   * const mounts = mounter.generateDockerMounts(weights);
   * // docker run -d [mounts] my-image
   */
  generateDockerMounts(weights: CachedWeight[]): string {
    const start = Date.now();
    
    try {
      if (!Array.isArray(weights)) {
        throw new ValidationError('weights must be an array');
      }

      const mounts = weights.map(weight => {
        this.validateWeight(weight);
        return `-v ${weight.storagePath}:${weight.mountPoint}:ro`;
      });

      const result = mounts.join(' ');
      logger.info(`Generated Docker mounts for ${weights.length} weights in ${Date.now() - start}ms`);
      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Failed to generate Docker mounts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate Kubernetes volumeMounts for Pod specs
   *
   * @param weights Array of cached weights to mount
   * @returns Array of Kubernetes volumeMounts configurations
   * @throws {ValidationError} If weights array is invalid
   *
   * @example
   * const mounts = mounter.generateK8sMounts(weights);
   * // Use in Pod spec containers[].volumeMounts
   */
  generateK8sMounts(weights: CachedWeight[]): K8sVolumeMount[] {
    const start = Date.now();

    try {
      if (!Array.isArray(weights)) {
        throw new ValidationError('weights must be an array');
      }

      const mounts = weights.map(weight => {
        this.validateWeight(weight);
        return {
          name: this.sanitizeK8sName(weight.modelHash),
          mountPath: weight.mountPoint,
          readOnly: true,
        };
      });

      logger.info(`Generated K8s volumeMounts for ${weights.length} weights in ${Date.now() - start}ms`);
      return mounts;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Failed to generate K8s volumeMounts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate Kubernetes volumes for Pod specs
   *
   * @param weights Array of cached weights to mount
   * @returns Array of Kubernetes volume definitions
   * @throws {ValidationError} If weights array is invalid
   *
   * @example
   * const volumes = mounter.generateK8sVolumes(weights);
   * // Use in Pod spec volumes[]
   */
  generateK8sVolumes(weights: CachedWeight[]): K8sVolume[] {
    const start = Date.now();

    try {
      if (!Array.isArray(weights)) {
        throw new ValidationError('weights must be an array');
      }

      const volumes = weights.map(weight => {
        this.validateWeight(weight);
        return {
          name: this.sanitizeK8sName(weight.modelHash),
          hostPath: {
            path: weight.storagePath,
            type: 'Directory' as const,
          },
        };
      });

      logger.info(`Generated K8s volumes for ${weights.length} weights in ${Date.now() - start}ms`);
      return volumes;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Failed to generate K8s volumes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate Docker Compose volume definitions
   *
   * @param weights Array of cached weights to mount
   * @returns Record of volume name to Docker Compose volume configuration
   * @throws {ValidationError} If weights array is invalid
   *
   * @example
   * const volumes = mounter.generateDockerComposeVolumes(weights);
   * // Use in docker-compose.yml services.service.volumes and top-level volumes
   */
  generateDockerComposeVolumes(weights: CachedWeight[]): Record<string, DockerComposeVolumeConfig> {
    const start = Date.now();

    try {
      if (!Array.isArray(weights)) {
        throw new ValidationError('weights must be an array');
      }

      const volumes: Record<string, DockerComposeVolumeConfig> = {};

      weights.forEach(weight => {
        this.validateWeight(weight);
        const volumeName = this.sanitizeK8sName(weight.modelHash);
        
        volumes[volumeName] = {
          driver: 'local',
          driver_opts: {
            type: 'none',
            o: 'bind',
            device: weight.storagePath,
          },
          labels: {
            model_hash: weight.modelHash,
            framework: weight.framework,
            size_gb: weight.sizeGB.toString(),
          },
        };
      });

      logger.info(`Generated Docker Compose volumes for ${weights.length} weights in ${Date.now() - start}ms`);
      return volumes;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Failed to generate Docker Compose volumes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Validate that a weight has all required fields
   *
   * @private
   * @param weight Weight to validate
   * @throws {ValidationError} If weight is missing required fields
   */
  private validateWeight(weight: CachedWeight): void {
    if (!weight.modelHash || typeof weight.modelHash !== 'string') {
      throw new ValidationError('Weight must have a valid modelHash');
    }
    if (!weight.storagePath || typeof weight.storagePath !== 'string') {
      throw new ValidationError(`Weight ${weight.modelHash} must have a valid storagePath`);
    }
    if (!weight.mountPoint || typeof weight.mountPoint !== 'string') {
      throw new ValidationError(`Weight ${weight.modelHash} must have a valid mountPoint`);
    }
  }

  /**
   * Sanitize a name for use in Kubernetes resources
   * - Converts to lowercase
   * - Replaces invalid characters with hyphens
   * - Removes leading/trailing hyphens
   * - Limits to 253 characters (Kubernetes DNS label limit)
   *
   * @private
   * @param name Name to sanitize
   * @returns Sanitized name safe for Kubernetes
   */
  private sanitizeK8sName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 253);
  }
}
