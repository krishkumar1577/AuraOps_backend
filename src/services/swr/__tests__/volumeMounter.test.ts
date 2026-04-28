import { VolumeMounter } from '../volumeMounter';
import type { CachedWeight } from '../redisClient';
import { ValidationError } from '../../../utils/errors';

describe('VolumeMounter', () => {
  let mounter: VolumeMounter;

  beforeEach(() => {
    mounter = new VolumeMounter();
  });

  const mockWeights: CachedWeight[] = [
    {
      modelHash: 'abc123',
      framework: 'pytorch',
      sizeGB: 10,
      storagePath: '/data/models/abc123',
      mountPoint: '/models/pytorch/abc123',
      lastAccessed: Date.now(),
      cacheHits: 100,
      ttlSeconds: 2592000,
    },
    {
      modelHash: 'def456',
      framework: 'transformers',
      sizeGB: 15,
      storagePath: '/data/models/def456',
      mountPoint: '/models/transformers/def456',
      lastAccessed: Date.now(),
      cacheHits: 50,
      ttlSeconds: 2592000,
    },
  ];

  describe('generateDockerMounts', () => {
    it('should generate Docker mount strings', () => {
      const mounts = mounter.generateDockerMounts(mockWeights);

      expect(mounts).toContain('-v /data/models/abc123:/models/pytorch/abc123:ro');
      expect(mounts).toContain('-v /data/models/def456:/models/transformers/def456:ro');
    });

    it('should generate mounts for single weight', () => {
      const singleWeight = [mockWeights[0]];
      const mounts = mounter.generateDockerMounts(singleWeight);

      expect(mounts).toBe('-v /data/models/abc123:/models/pytorch/abc123:ro');
    });

    it('should return empty string for empty weights', () => {
      const mounts = mounter.generateDockerMounts([]);

      expect(mounts).toBe('');
    });

    it('should set volumes as read-only', () => {
      const mounts = mounter.generateDockerMounts(mockWeights);

      expect(mounts).toMatch(/:ro/g);
    });

    it('should throw ValidationError for invalid input', () => {
      // @ts-ignore - Testing invalid input
      expect(() => mounter.generateDockerMounts(null)).toThrow(ValidationError);
    });

    it('should throw ValidationError for weight with missing storagePath', () => {
      const invalidWeight: CachedWeight = {
        ...mockWeights[0],
        storagePath: '',
      };

      expect(() => mounter.generateDockerMounts([invalidWeight])).toThrow(ValidationError);
    });

    it('should throw ValidationError for weight with missing mountPoint', () => {
      const invalidWeight: CachedWeight = {
        ...mockWeights[0],
        mountPoint: '',
      };

      expect(() => mounter.generateDockerMounts([invalidWeight])).toThrow(ValidationError);
    });
  });

  describe('generateK8sMounts', () => {
    it('should generate K8s volume mounts', () => {
      const mounts = mounter.generateK8sMounts(mockWeights);

      expect(mounts).toHaveLength(2);
      expect(mounts[0]).toEqual({
        name: 'abc123',
        mountPath: '/models/pytorch/abc123',
        readOnly: true,
      });
      expect(mounts[1]).toEqual({
        name: 'def456',
        mountPath: '/models/transformers/def456',
        readOnly: true,
      });
    });

    it('should sanitize hash names for K8s', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'Model_123-ABC',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);

      expect(mounts[0].name).toBe('model-123-abc');
    });

    it('should return empty array for empty weights', () => {
      const mounts = mounter.generateK8sMounts([]);

      expect(mounts).toEqual([]);
    });

    it('should always set readOnly to true', () => {
      const mounts = mounter.generateK8sMounts(mockWeights);

      mounts.forEach(mount => {
        expect(mount.readOnly).toBe(true);
      });
    });

    it('should throw ValidationError for invalid input', () => {
      // @ts-ignore - Testing invalid input
      expect(() => mounter.generateK8sMounts(null)).toThrow(ValidationError);
    });
  });

  describe('generateK8sVolumes', () => {
    it('should generate K8s volume definitions', () => {
      const volumes = mounter.generateK8sVolumes(mockWeights);

      expect(volumes).toHaveLength(2);
      expect(volumes[0]).toEqual({
        name: 'abc123',
        hostPath: {
          path: '/data/models/abc123',
          type: 'Directory',
        },
      });
    });

    it('should sanitize volume names', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'Test_Model@v2',
        },
      ];

      const volumes = mounter.generateK8sVolumes(weights);

      expect(volumes[0].name).toBe('test-model-v2');
    });

    it('should set type to Directory', () => {
      const volumes = mounter.generateK8sVolumes(mockWeights);

      volumes.forEach(volume => {
        expect(volume.hostPath.type).toBe('Directory');
      });
    });

    it('should throw ValidationError for invalid input', () => {
      // @ts-ignore - Testing invalid input
      expect(() => mounter.generateK8sVolumes(null)).toThrow(ValidationError);
    });
  });

  describe('generateDockerComposeVolumes', () => {
    it('should generate Docker Compose volume definitions', () => {
      const volumes = mounter.generateDockerComposeVolumes(mockWeights);

      expect(Object.keys(volumes)).toHaveLength(2);
      expect(volumes.abc123).toBeDefined();
      expect(volumes.def456).toBeDefined();
    });

    it('should set driver to local', () => {
      const volumes = mounter.generateDockerComposeVolumes(mockWeights);

      expect(volumes.abc123.driver).toBe('local');
      expect(volumes.def456.driver).toBe('local');
    });

    it('should include driver options with bind mount', () => {
      const volumes = mounter.generateDockerComposeVolumes(mockWeights);

      expect(volumes.abc123.driver_opts).toEqual({
        type: 'none',
        o: 'bind',
        device: '/data/models/abc123',
      });
    });

    it('should include labels with model metadata', () => {
      const volumes = mounter.generateDockerComposeVolumes(mockWeights);

      expect(volumes.abc123.labels).toEqual({
        model_hash: 'abc123',
        framework: 'pytorch',
        size_gb: '10',
      });
      expect(volumes.def456.labels?.framework).toBe('transformers');
    });

    it('should return empty object for empty weights', () => {
      const volumes = mounter.generateDockerComposeVolumes([]);

      expect(volumes).toEqual({});
    });

    it('should throw ValidationError for invalid input', () => {
      // @ts-ignore - Testing invalid input
      expect(() => mounter.generateDockerComposeVolumes(null)).toThrow(ValidationError);
    });

    it('should sanitize volume names for Docker Compose', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'Model@123_ABC',
        },
      ];

      const volumes = mounter.generateDockerComposeVolumes(weights);

      expect(Object.keys(volumes)[0]).toBe('model-123-abc');
    });
  });

  describe('name sanitization', () => {
    it('should convert uppercase to lowercase', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'UPPERCASE',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name).toBe('uppercase');
    });

    it('should replace invalid characters with hyphens', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'test@#$%model',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name).not.toMatch(/[^a-z0-9-]/);
    });

    it('should remove leading/trailing hyphens', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: '---model---',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name).not.toMatch(/^-|-$/);
    });

    it('should limit name to 253 characters', () => {
      const longHash = 'a'.repeat(300);
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: longHash,
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name.length).toBeLessThanOrEqual(253);
    });

    it('should handle complex special characters', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'Model!@#$%^&*()_+-=[]{}|;:,.<>?',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name).toMatch(/^[a-z0-9-]+$/);
      expect(mounts[0].name).not.toMatch(/^-|-$/);
    });
  });

  describe('integration', () => {
    it('should generate complete Docker run command', () => {
      const mounts = mounter.generateDockerMounts(mockWeights);
      const command = `docker run -d ${mounts} my-image`;

      expect(command).toContain('docker run');
      expect(command).toContain('-v /data/models/abc123:/models/pytorch/abc123:ro');
      expect(command).toContain('-v /data/models/def456:/models/transformers/def456:ro');
    });

    it('should generate complete K8s Pod spec', () => {
      const mounts = mounter.generateK8sMounts(mockWeights);
      const volumes = mounter.generateK8sVolumes(mockWeights);

      expect(mounts).toHaveLength(2);
      expect(volumes).toHaveLength(2);

      mounts.forEach((mount, idx) => {
        expect(mount.name).toBe(volumes[idx].name);
      });
    });

    it('should generate complete Docker Compose config', () => {
      const volumes = mounter.generateDockerComposeVolumes(mockWeights);

      const compose = {
        version: '3.9',
        services: {
          agent: {
            image: 'auraops/agent:latest',
            volumes: [
              `${Object.keys(volumes)[0]}:/models/pytorch/abc123`,
              `${Object.keys(volumes)[1]}:/models/transformers/def456`,
            ],
          },
        },
        volumes,
      };

      expect(compose.volumes.abc123.driver).toBe('local');
      expect(compose.volumes.def456.labels?.framework).toBe('transformers');
    });

    it('should coordinate mounts and volumes across all formats', () => {
      const dockerMounts = mounter.generateDockerMounts(mockWeights);
      const k8sMounts = mounter.generateK8sMounts(mockWeights);
      const k8sVolumes = mounter.generateK8sVolumes(mockWeights);
      const composevolumes = mounter.generateDockerComposeVolumes(mockWeights);

      // All should reference same weights
      expect(dockerMounts).toContain('abc123');
      expect(dockerMounts).toContain('def456');
      expect(k8sMounts).toHaveLength(2);
      expect(k8sVolumes).toHaveLength(2);
      expect(Object.keys(composevolumes)).toHaveLength(2);

      // Mount points should be consistent
      expect(k8sMounts[0].mountPath).toBe(mockWeights[0].mountPoint);
      expect(k8sVolumes[0].hostPath.path).toBe(mockWeights[0].storagePath);
    });
  });

  describe('edge cases', () => {
    it('should handle weights with special paths', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          storagePath: '/data/models/v1.0-beta/abc123',
          mountPoint: '/models/pytorch-v1.0/abc123',
        },
      ];

      const mounts = mounter.generateDockerMounts(weights);
      expect(mounts).toContain('/data/models/v1.0-beta/abc123');
    });

    it('should handle many weights', () => {
      const manyWeights = Array.from({ length: 50 }, (_, i) => ({
        ...mockWeights[0],
        modelHash: `model-${i}`,
        storagePath: `/data/models/model-${i}`,
        mountPoint: `/models/pytorch/model-${i}`,
      }));

      const mounts = mounter.generateK8sMounts(manyWeights);
      expect(mounts).toHaveLength(50);
      expect(mounts.every(m => m.readOnly)).toBe(true);

      const volumes = mounter.generateDockerComposeVolumes(manyWeights);
      expect(Object.keys(volumes)).toHaveLength(50);
    });

    it('should handle weights with unicode characters', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'model-émojis-🚀-test',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name).toMatch(/^[a-z0-9-]+$/);
    });

    it('should handle weights with consecutive special characters', () => {
      const weights: CachedWeight[] = [
        {
          ...mockWeights[0],
          modelHash: 'model___===???test',
        },
      ];

      const mounts = mounter.generateK8sMounts(weights);
      expect(mounts[0].name).toMatch(/^[a-z0-9-]+$/);
      expect(mounts[0].name).not.toMatch(/^-|-$/); // No leading/trailing hyphens
    });
  });

  describe('error handling', () => {
    it('should throw error for weight with missing modelHash', () => {
      const invalidWeight: CachedWeight = {
        ...mockWeights[0],
        modelHash: '',
      };

      expect(() => mounter.generateDockerMounts([invalidWeight])).toThrow(ValidationError);
    });

    it('should throw error for null weight properties', () => {
      const invalidWeight: Partial<CachedWeight> = {
        ...mockWeights[0],
        storagePath: null as any,
      };

      expect(() => mounter.generateDockerMounts([invalidWeight as CachedWeight])).toThrow(ValidationError);
    });

    it('should provide clear error messages', () => {
      const invalidWeight: CachedWeight = {
        ...mockWeights[0],
        modelHash: '',
      };

      try {
        mounter.generateDockerMounts([invalidWeight]);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (error instanceof ValidationError) {
          expect(error.message).toContain('modelHash');
        }
      }
    });
  });

  describe('performance', () => {
    it('should generate mounts for 100 weights in reasonable time', () => {
      const weights = Array.from({ length: 100 }, (_, i) => ({
        ...mockWeights[0],
        modelHash: `model-${i}`,
        storagePath: `/data/models/model-${i}`,
        mountPoint: `/models/pytorch/model-${i}`,
      }));

      const start = Date.now();
      mounter.generateDockerMounts(weights);
      const dockerTime = Date.now() - start;

      const start2 = Date.now();
      mounter.generateK8sMounts(weights);
      const k8sTime = Date.now() - start2;

      const start3 = Date.now();
      mounter.generateDockerComposeVolumes(weights);
      const composeTime = Date.now() - start3;

      // All operations should complete in < 100ms
      expect(dockerTime).toBeLessThan(100);
      expect(k8sTime).toBeLessThan(100);
      expect(composeTime).toBeLessThan(100);
    });
  });
});
