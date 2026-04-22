import { VolumeMounter } from '../volumeMounter';
import type { CachedWeight } from '../redisClient';

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
    });
  });
});
