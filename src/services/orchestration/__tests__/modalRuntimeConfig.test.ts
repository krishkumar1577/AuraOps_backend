import { createHash } from 'crypto';
import {
  escapePythonString,
  formatModalSecretsArg,
  formatModalVolumesArg,
  generateRuntimeBootstrapPython,
  generateWeightVolumePython,
  isRemoteModelPath,
  needsBoto3ForModels,
  needsWeightVolume,
  weightCacheKey,
  WEIGHTS_MOUNT_PATH,
  WEIGHTS_VOLUME_NAME,
  WEIGHTS_VOLUME_VAR,
  type CustomModelRef,
} from '../modalRuntimeConfig';

describe('modalRuntimeConfig', () => {
  describe('escapePythonString', () => {
    it('escapes backslashes, quotes, and control chars', () => {
      expect(escapePythonString('a\\b"c\n\t')).toBe('a\\\\b\\"c\\n\\t');
    });
  });

  describe('isRemoteModelPath / needsWeightVolume', () => {
    it('detects s3 and http(s) paths', () => {
      expect(isRemoteModelPath('s3://bucket/key')).toBe(true);
      expect(isRemoteModelPath('https://cdn.example/w.bin')).toBe(true);
      expect(isRemoteModelPath('http://cdn.example/w.bin')).toBe(true);
      expect(isRemoteModelPath('/models/local.bin')).toBe(false);
      expect(isRemoteModelPath('hf://org/model')).toBe(false);
    });

    it('needsWeightVolume only when a remote path is present', () => {
      expect(needsWeightVolume(undefined)).toBe(false);
      expect(needsWeightVolume([])).toBe(false);
      expect(
        needsWeightVolume([{ name: 'local', path: '/models/x', hash: 'h' }]),
      ).toBe(false);
      expect(
        needsWeightVolume([
          { name: 'local', path: '/models/x', hash: 'h' },
          { name: 'remote', path: 's3://b/k', hash: 'r' },
        ]),
      ).toBe(true);
    });
  });

  describe('weightCacheKey', () => {
    it('prefers model.hash when present', () => {
      expect(weightCacheKey({ name: 'm', path: 's3://b/k', hash: 'abc' })).toBe('abc');
    });

    it('falls back to sha256(path)[:16]', () => {
      const path = 'https://example.com/weights.bin';
      const expected = createHash('sha256').update(path).digest('hex').slice(0, 16);
      expect(weightCacheKey({ name: 'm', path })).toBe(expected);
    });
  });

  describe('generateWeightVolumePython / formatModalVolumesArg', () => {
    const remote: CustomModelRef[] = [
      { name: 'w', path: 'https://example.com/m.bin', hash: 'h1' },
    ];

    it('emits Volume.from_name when remote models exist', () => {
      const py = generateWeightVolumePython(remote);
      expect(py).toContain(`modal.Volume.from_name("${WEIGHTS_VOLUME_NAME}"`);
      expect(py).toContain('create_if_missing=True');
      expect(py).toContain(WEIGHTS_VOLUME_VAR);
      expect(py).toContain('Cold path');
      expect(py).toContain('Warm path');
    });

    it('emits empty volume declaration without remote models', () => {
      expect(generateWeightVolumePython([])).toBe('');
      expect(generateWeightVolumePython([{ name: 'l', path: '/local' }])).toBe('');
      expect(generateWeightVolumePython(undefined)).toBe('');
    });

    it('formats volumes= arg only for remote models', () => {
      expect(formatModalVolumesArg(remote)).toBe(
        `,\n    volumes={"${WEIGHTS_MOUNT_PATH}": ${WEIGHTS_VOLUME_VAR}}`,
      );
      expect(formatModalVolumesArg([])).toBe('');
      expect(formatModalVolumesArg([{ name: 'l', path: '/local' }])).toBe('');
    });
  });

  describe('formatModalSecretsArg', () => {
    it('returns empty when no secrets', () => {
      expect(formatModalSecretsArg(undefined)).toBe('');
      expect(formatModalSecretsArg([])).toBe('');
    });

    it('formats Secret.from_name list', () => {
      expect(formatModalSecretsArg(['auraops-agent'])).toContain(
        'modal.Secret.from_name("auraops-agent")',
      );
    });
  });

  describe('generateRuntimeBootstrapPython', () => {
    it('returns empty when no env and no models', () => {
      expect(generateRuntimeBootstrapPython({})).toBe('');
    });

    it('injects env setdefault only', () => {
      const py = generateRuntimeBootstrapPython({
        env: { OPENAI_API_KEY: 'sk-test' },
      });
      expect(py).toContain('os.environ.setdefault("OPENAI_API_KEY", "sk-test")');
      expect(py).not.toContain('download');
    });

    it('generates exists-check + download + commit for https weights', () => {
      const py = generateRuntimeBootstrapPython({
        customModels: [
          {
            name: 'http-w',
            path: 'https://example.com/weights/model.bin',
            hash: 'abc123hash',
          },
        ],
      });

      expect(py).toContain(`_dest_0 = "${WEIGHTS_MOUNT_PATH}/abc123hash"`);
      expect(py).toContain('if not os.path.exists(_dest_0):');
      expect(py).toContain('urllib.request');
      expect(py).toContain('urlretrieve');
      expect(py).toContain(`${WEIGHTS_VOLUME_VAR}.commit()`);
      expect(py).toContain('Weight cache hit');
      expect(py).toContain('fridge filled');
      expect(py).toContain('AURAOPS_MODEL_PATH');
    });

    it('generates s3 download + commit for s3 weights', () => {
      const py = generateRuntimeBootstrapPython({
        customModels: [
          {
            name: 's3-w',
            path: 's3://bucket/models/w.bin',
            hash: 's3key',
          },
        ],
      });

      expect(py).toContain('import boto3');
      expect(py).toContain('download_file');
      expect(py).toContain(`${WEIGHTS_VOLUME_VAR}.commit()`);
      expect(py).toContain(`_dest_0 = "${WEIGHTS_MOUNT_PATH}/s3key"`);
    });

    it('uses path digest when hash is missing', () => {
      const path = 'https://cdn.example/m.bin';
      const key = weightCacheKey({ name: 'm', path });
      const py = generateRuntimeBootstrapPython({
        customModels: [{ name: 'm', path }],
      });
      expect(py).toContain(`_dest_0 = "${WEIGHTS_MOUNT_PATH}/${key}"`);
    });

    it('does not commit for local-only model paths', () => {
      const py = generateRuntimeBootstrapPython({
        customModels: [{ name: 'local', path: '/models/llama', hash: 'h' }],
      });
      expect(py).toContain('AURAOPS_MODEL_PATH');
      expect(py).toContain('_dest_0 = _src_0');
      expect(py).not.toContain('.commit()');
      expect(py).not.toContain('urlretrieve');
    });
  });

  describe('needsBoto3ForModels', () => {
    it('is true only for s3 paths', () => {
      expect(needsBoto3ForModels([{ name: 'h', path: 'https://x' }])).toBe(false);
      expect(needsBoto3ForModels([{ name: 's', path: 's3://b/k' }])).toBe(true);
    });
  });
});
