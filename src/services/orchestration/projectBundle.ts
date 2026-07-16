import * as fs from 'fs/promises';
import * as path from 'path';
import { shouldIgnoreProjectEntry } from './userProjectDeploy';

/** Bundle wire format: JSON file map, base64-encoded for HTTP transport. */
export const PROJECT_BUNDLE_FORMAT_FILES_V1 = 'files-v1' as const;
export type ProjectBundleFormat = typeof PROJECT_BUNDLE_FORMAT_FILES_V1 | 'targz';

/** Max sum of raw file sizes when packing (uncompressed). Code-only budget. */
export const MAX_BUNDLE_UNCOMPRESSED_BYTES = 25 * 1024 * 1024; // 25MB

/** Max number of files included in a bundle. */
export const MAX_BUNDLE_FILE_COUNT = 5000;

/**
 * Single files larger than this are auto-skipped (models/data dumps).
 * Remaining code should stay well under the bundle budget.
 */
export const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024; // 2MB

/** Model/weight/data extensions auto-excluded from project bundles. */
export const WEIGHT_FILE_EXTENSIONS = [
  '.pt',
  '.pth',
  '.bin',
  '.onnx',
  '.safetensors',
  '.ckpt',
  '.h5',
  '.pkl',
  '.pickle',
  '.npy',
  '.npz',
  '.gguf',
  '.ggml',
  '.msgpack',
  '.arrow',
  '.parquet',
] as const;

/** Directory basenames auto-excluded (model caches, experiment artifacts). */
export const WEIGHT_DIR_NAMES = [
  'models',
  'checkpoints',
  'weights',
  '.cache',
  'huggingface',
  'wandb',
] as const;

const WEIGHT_EXT_SET = new Set<string>(WEIGHT_FILE_EXTENSIONS);
const WEIGHT_DIR_SET = new Set<string>(WEIGHT_DIR_NAMES);

export interface FilesV1Bundle {
  format: typeof PROJECT_BUNDLE_FORMAT_FILES_V1;
  /** relativePath → base64(raw file bytes) */
  files: Record<string, string>;
}

export interface PackProjectBundleResult {
  /** Base64-encoded JSON bundle payload. */
  projectBundleBase64: string;
  projectBundleFormat: typeof PROJECT_BUNDLE_FORMAT_FILES_V1;
  fileCount: number;
  uncompressedBytes: number;
  /** Count of weight/large files auto-skipped during pack. */
  skippedFiles: number;
  /** Total bytes of auto-skipped files. */
  skippedBytes: number;
}

function isWeightExtension(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return WEIGHT_EXT_SET.has(lower.slice(dot));
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  return `${n}B`;
}

function buildOversizeError(
  uncompressedBytes: number,
  skippedFiles: number,
  packedFileSizes: Array<{ path: string; size: number }>,
): Error {
  const top = [...packedFileSizes].sort((a, b) => b.size - a.size).slice(0, 5);
  const topList =
    top.length > 0
      ? '\nLargest remaining files:\n' +
        top.map((f) => `  - ${f.path} (${formatBytes(f.size)})`).join('\n')
      : '';

  return new Error(
    `Project bundle exceeds ${MAX_BUNDLE_UNCOMPRESSED_BYTES} bytes uncompressed ` +
      `(got at least ${uncompressedBytes}). ` +
      `Large model files were skipped (${skippedFiles} files). ` +
      `Put weights on S3/HF and list in blueprint customModels. ` +
      `Bundle limit is ${MAX_BUNDLE_UNCOMPRESSED_BYTES}.${topList}`,
  );
}

/**
 * Walk project tree, skip ignored entries (node_modules, .git, etc.),
 * auto-skip model/weight/data files and oversized singles, and pack into a
 * base64-encoded files-v1 JSON map.
 */
export async function packProjectBundle(projectPath: string): Promise<PackProjectBundleResult> {
  const root = path.resolve(projectPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${root}`);
  }

  const files: Record<string, string> = {};
  let uncompressedBytes = 0;
  let fileCount = 0;
  let skippedFiles = 0;
  let skippedBytes = 0;
  const packedFileSizes: Array<{ path: string; size: number }> = [];

  function skipFile(size: number): void {
    skippedFiles += 1;
    skippedBytes += size;
  }

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreProjectEntry(entry.name)) {
        continue;
      }

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WEIGHT_DIR_SET.has(entry.name)) {
          // Walk to accumulate skip stats without packing contents
          await walkSkipDir(abs);
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const rel = path.relative(root, abs).split(path.sep).join('/');
      const fileStat = await fs.stat(abs);

      if (isWeightExtension(entry.name) || fileStat.size > MAX_SINGLE_FILE_BYTES) {
        skipFile(fileStat.size);
        continue;
      }

      const buf = await fs.readFile(abs);
      uncompressedBytes += buf.length;
      packedFileSizes.push({ path: rel, size: buf.length });

      if (uncompressedBytes > MAX_BUNDLE_UNCOMPRESSED_BYTES) {
        throw buildOversizeError(uncompressedBytes, skippedFiles, packedFileSizes);
      }

      fileCount += 1;
      if (fileCount > MAX_BUNDLE_FILE_COUNT) {
        throw new Error(`Project bundle exceeds ${MAX_BUNDLE_FILE_COUNT} files`);
      }

      files[rel] = buf.toString('base64');
    }
  }

  /** Count files under a weight/cache dir as skipped (do not pack). */
  async function walkSkipDir(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkSkipDir(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fileStat = await fs.stat(abs);
      skipFile(fileStat.size);
    }
  }

  await walk(root);

  const payload: FilesV1Bundle = {
    format: PROJECT_BUNDLE_FORMAT_FILES_V1,
    files,
  };

  return {
    projectBundleBase64: Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64'),
    projectBundleFormat: PROJECT_BUNDLE_FORMAT_FILES_V1,
    fileCount,
    uncompressedBytes,
    skippedFiles,
    skippedBytes,
  };
}

/**
 * Decode a project bundle and write files under destDir.
 * Creates destDir if missing. Returns the absolute destination path.
 */
export async function unpackProjectBundle(
  projectBundleBase64: string,
  destDir: string,
  format: ProjectBundleFormat = PROJECT_BUNDLE_FORMAT_FILES_V1,
): Promise<string> {
  if (format === 'targz') {
    throw new Error('projectBundleFormat "targz" is not supported yet; use files-v1');
  }
  if (format !== PROJECT_BUNDLE_FORMAT_FILES_V1) {
    throw new Error(`Unsupported projectBundleFormat: ${String(format)}`);
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(projectBundleBase64, 'base64').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid projectBundleBase64: failed to decode files-v1 JSON');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as FilesV1Bundle).format !== PROJECT_BUNDLE_FORMAT_FILES_V1 ||
    typeof (parsed as FilesV1Bundle).files !== 'object' ||
    (parsed as FilesV1Bundle).files === null ||
    Array.isArray((parsed as FilesV1Bundle).files)
  ) {
    throw new Error('Invalid project bundle: expected { format: "files-v1", files: { ... } }');
  }

  const { files } = parsed as FilesV1Bundle;
  const outRoot = path.resolve(destDir);
  await fs.mkdir(outRoot, { recursive: true });

  let uncompressedBytes = 0;
  let fileCount = 0;

  for (const [relPath, b64] of Object.entries(files)) {
    if (typeof b64 !== 'string') {
      throw new Error(`Invalid project bundle entry for ${relPath}: content must be base64 string`);
    }

    // Prevent path traversal (reject abs paths and any ".." segment)
    const normalized = path.normalize(relPath);
    const segments = normalized.split(/[/\\]/).filter(Boolean);
    if (
      path.isAbsolute(normalized) ||
      segments.length === 0 ||
      segments.some((seg) => seg === '..')
    ) {
      throw new Error(`Invalid project bundle path: ${relPath}`);
    }

    if (segments.some((seg) => shouldIgnoreProjectEntry(seg))) {
      continue;
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      throw new Error(`Invalid base64 content for ${relPath}`);
    }

    uncompressedBytes += buf.length;
    if (uncompressedBytes > MAX_BUNDLE_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Unpacked project bundle exceeds ${MAX_BUNDLE_UNCOMPRESSED_BYTES} bytes`,
      );
    }

    fileCount += 1;
    if (fileCount > MAX_BUNDLE_FILE_COUNT) {
      throw new Error(`Unpacked project bundle exceeds ${MAX_BUNDLE_FILE_COUNT} files`);
    }

    const abs = path.join(outRoot, normalized);
    const resolved = path.resolve(abs);
    if (!resolved.startsWith(outRoot + path.sep) && resolved !== outRoot) {
      throw new Error(`Invalid project bundle path escapes dest: ${relPath}`);
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, buf);
  }

  return outRoot;
}
