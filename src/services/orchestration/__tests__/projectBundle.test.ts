import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_BUNDLE_UNCOMPRESSED_BYTES,
  MAX_SINGLE_FILE_BYTES,
  packProjectBundle,
  unpackProjectBundle,
  PROJECT_BUNDLE_FORMAT_FILES_V1,
} from '../projectBundle';

async function makeTempProject(structure: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-src-'));
  for (const [rel, content] of Object.entries(structure)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

describe('projectBundle', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)),
    );
    dirs = [];
  });

  it('packs and unpacks a roundtrip preserving text and binary files', async () => {
    const src = await makeTempProject({
      'main.py': 'print("hello")\n',
      'src/agent.py': 'def run():\n    return 1\n',
      'data/blob.dat': Buffer.from([0x00, 0x01, 0xff, 0xfe]),
      'requirements.txt': 'requests==2.0.0\n',
    });
    dirs.push(src);

    const packed = await packProjectBundle(src);
    expect(packed.projectBundleFormat).toBe(PROJECT_BUNDLE_FORMAT_FILES_V1);
    expect(packed.fileCount).toBe(4);
    expect(packed.uncompressedBytes).toBeGreaterThan(0);
    expect(packed.projectBundleBase64.length).toBeGreaterThan(0);
    expect(packed.skippedFiles).toBe(0);
    expect(packed.skippedBytes).toBe(0);

    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-dst-'));
    dirs.push(dest);

    const out = await unpackProjectBundle(
      packed.projectBundleBase64,
      dest,
      packed.projectBundleFormat,
    );
    expect(out).toBe(path.resolve(dest));

    expect(await fs.readFile(path.join(dest, 'main.py'), 'utf-8')).toBe('print("hello")\n');
    expect(await fs.readFile(path.join(dest, 'src/agent.py'), 'utf-8')).toBe(
      'def run():\n    return 1\n',
    );
    expect(await fs.readFile(path.join(dest, 'requirements.txt'), 'utf-8')).toBe(
      'requests==2.0.0\n',
    );
    expect(Buffer.from(await fs.readFile(path.join(dest, 'data/blob.dat')))).toEqual(
      Buffer.from([0x00, 0x01, 0xff, 0xfe]),
    );
  });

  it('skips ignored directories and .pyc files', async () => {
    const src = await makeTempProject({
      'main.py': 'ok\n',
      'node_modules/pkg/index.js': 'secret\n',
      '.git/config': 'git\n',
      '.env': 'SECRET=1\n',
      '__pycache__/mod.pyc': Buffer.from([1, 2, 3]),
      'src/mod.pyc': Buffer.from([4, 5]),
      'src/keep.py': 'keep\n',
      '.venv/bin/python': 'x\n',
    });
    dirs.push(src);

    const packed = await packProjectBundle(src);
    expect(packed.fileCount).toBe(2);

    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-dst-'));
    dirs.push(dest);
    await unpackProjectBundle(packed.projectBundleBase64, dest);

    expect(await fs.readFile(path.join(dest, 'main.py'), 'utf-8')).toBe('ok\n');
    expect(await fs.readFile(path.join(dest, 'src/keep.py'), 'utf-8')).toBe('keep\n');

    await expect(fs.access(path.join(dest, 'node_modules'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, '.git'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, '.env'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, 'src/mod.pyc'))).rejects.toThrow();
  });

  it('skips .safetensors / models/ dir but still packs .py', async () => {
    const weight = Buffer.alloc(1024, 0xab);
    const src = await makeTempProject({
      'main.py': 'print("ok")\n',
      'src/agent.py': 'def run(): pass\n',
      'model.safetensors': weight,
      'weights/ckpt.pt': weight,
      'models/bert/config.json': '{"x":1}\n',
      'models/bert/model.bin': weight,
      'checkpoints/epoch1.ckpt': weight,
      'data/sample.parquet': weight,
    });
    dirs.push(src);

    const packed = await packProjectBundle(src);
    expect(packed.fileCount).toBe(2);
    expect(packed.skippedFiles).toBeGreaterThanOrEqual(5);
    expect(packed.skippedBytes).toBeGreaterThan(0);

    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-dst-'));
    dirs.push(dest);
    await unpackProjectBundle(packed.projectBundleBase64, dest);

    expect(await fs.readFile(path.join(dest, 'main.py'), 'utf-8')).toBe('print("ok")\n');
    expect(await fs.readFile(path.join(dest, 'src/agent.py'), 'utf-8')).toBe('def run(): pass\n');
    await expect(fs.access(path.join(dest, 'model.safetensors'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, 'models'))).rejects.toThrow();
    await expect(fs.access(path.join(dest, 'weights'))).rejects.toThrow();
  });

  it('skips single files larger than MAX_SINGLE_FILE_BYTES', async () => {
    const big = Buffer.alloc(MAX_SINGLE_FILE_BYTES + 1, 0xcd);
    const src = await makeTempProject({
      'main.py': 'ok\n',
      'assets/huge.json': big,
    });
    dirs.push(src);

    const packed = await packProjectBundle(src);
    expect(packed.fileCount).toBe(1);
    expect(packed.skippedFiles).toBe(1);
    expect(packed.skippedBytes).toBe(MAX_SINGLE_FILE_BYTES + 1);
  });

  it('rejects path traversal in unpack', async () => {
    const malicious = {
      format: PROJECT_BUNDLE_FORMAT_FILES_V1,
      files: {
        '../escape.txt': Buffer.from('nope').toString('base64'),
      },
    };
    const b64 = Buffer.from(JSON.stringify(malicious), 'utf-8').toString('base64');
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-dst-'));
    dirs.push(dest);

    await expect(unpackProjectBundle(b64, dest)).rejects.toThrow(/Invalid project bundle path/);
  });

  it('rejects invalid base64 payload', async () => {
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-dst-'));
    dirs.push(dest);
    await expect(unpackProjectBundle('not-valid-json!!!', dest)).rejects.toThrow(
      /Invalid projectBundleBase64/,
    );
  });

  it('rejects unsupported format', async () => {
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-bundle-dst-'));
    dirs.push(dest);
    await expect(
      unpackProjectBundle(
        Buffer.from('{}').toString('base64'),
        dest,
        'targz',
      ),
    ).rejects.toThrow(/not supported yet/);
  });

  it('rejects oversized pack with helpful guidance', async () => {
    // Many medium code files (each under single-file skip) that sum past the budget
    const chunk = Buffer.alloc(MAX_SINGLE_FILE_BYTES - 1024, 0xee);
    const structure: Record<string, string | Buffer> = {
      'main.py': 'print("hi")\n',
      'weights/model.safetensors': Buffer.alloc(5 * 1024 * 1024, 0xaa),
    };
    const chunksNeeded = Math.ceil(MAX_BUNDLE_UNCOMPRESSED_BYTES / chunk.length) + 1;
    for (let i = 0; i < chunksNeeded; i += 1) {
      structure[`src/chunk_${i}.dat`] = chunk;
    }

    const src = await makeTempProject(structure);
    dirs.push(src);

    await expect(packProjectBundle(src)).rejects.toThrow(
      /Large model files were skipped|customModels|Bundle limit|Largest remaining files/,
    );

    try {
      await packProjectBundle(src);
      fail('expected packProjectBundle to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/Large model files were skipped \(\d+ files\)/);
      expect(msg).toMatch(/customModels/);
      expect(msg).toMatch(/Bundle limit is/);
      expect(msg).toMatch(/Largest remaining files/);
      expect(msg).toMatch(/chunk_/);
    }
  });

  it('rejects pack of non-directory', async () => {
    const file = path.join(os.tmpdir(), `auraops-not-dir-${Date.now()}.txt`);
    await fs.writeFile(file, 'x');
    dirs.push(file);
    await expect(packProjectBundle(file)).rejects.toThrow(/not a directory/);
  });
});
