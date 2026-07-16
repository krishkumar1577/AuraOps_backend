/**
 * Helpers for Modal runtime env/secrets injection and custom-model weight bootstrap.
 * Kept separate from modalAppDeployer so generators stay small and unit-testable.
 */

import { createHash } from 'crypto';

export const AGENT_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
] as const;

/** Shared Modal Volume holding model weights across deploys / cold starts. */
export const WEIGHTS_VOLUME_NAME = 'auraops-weights';
/** Mount path for the shared weight fridge inside the container. */
export const WEIGHTS_MOUNT_PATH = '/models';
/** Python variable name for the shared volume handle. */
export const WEIGHTS_VOLUME_VAR = 'weights_vol';

export interface CustomModelRef {
  name: string;
  path: string;
  hash?: string;
  size?: number;
}

/** Escape a string for embedding inside a double-quoted Python string literal. */
export function escapePythonString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

/**
 * Collect agent env/secrets from the local process for local deploy.
 * - AURAOPS_AGENT_ENV: JSON object of string values
 * - Common API key env vars when present
 * - MODAL_SECRET_NAME or AURAOPS_MODAL_SECRET → secretNames
 * Never invents keys or values.
 */
export function collectAgentEnvFromProcess(
  env: NodeJS.ProcessEnv = process.env,
): {
  env?: Record<string, string>;
  secretNames?: string[];
} {
  const result: Record<string, string> = {};

  const rawJson = env.AURAOPS_AGENT_ENV;
  if (rawJson) {
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && k.length > 0) {
            result[k] = v;
          }
        }
      }
    } catch {
      // Invalid JSON — ignore; common keys below may still apply
    }
  }

  for (const key of AGENT_ENV_KEYS) {
    const val = env[key];
    if (val) {
      result[key] = val;
    }
  }

  const secretName = env.MODAL_SECRET_NAME || env.AURAOPS_MODAL_SECRET;
  const secretNames = secretName ? [secretName] : undefined;

  return {
    env: Object.keys(result).length > 0 ? result : undefined,
    secretNames,
  };
}

/** `@app.cls(..., secrets=[...])` fragment (leading comma + newline), or empty. */
export function formatModalSecretsArg(secretNames?: string[]): string {
  if (!secretNames || secretNames.length === 0) {
    return '';
  }
  const items = secretNames
    .map((n) => `modal.Secret.from_name("${escapePythonString(n)}")`)
    .join(', ');
  return `,\n    secrets=[${items}]`;
}

/** True when path is a remote weight source that may need download-on-miss. */
export function isRemoteModelPath(modelPath: string): boolean {
  return (
    modelPath.startsWith('s3://') ||
    modelPath.startsWith('https://') ||
    modelPath.startsWith('http://')
  );
}

/**
 * True when any custom model needs the shared Modal weight volume.
 * Local/image paths do not require volume overhead.
 */
export function needsWeightVolume(customModels?: CustomModelRef[]): boolean {
  return (customModels ?? []).some((m) => Boolean(m?.path) && isRemoteModelPath(m.path));
}

/**
 * Stable key for `/models/{key}` on the shared fridge.
 * Prefers model.hash; falls back to sha256(path)[:16].
 */
export function weightCacheKey(model: CustomModelRef): string {
  if (model.hash) {
    return model.hash;
  }
  return createHash('sha256').update(model.path).digest('hex').slice(0, 16);
}

/**
 * Module-level Python for the shared weight volume, or empty when no remote models.
 * First deploy fills the fridge; later deploys / cold starts reuse `/models/{hash}`.
 */
export function generateWeightVolumePython(customModels?: CustomModelRef[]): string {
  if (!needsWeightVolume(customModels)) {
    return '';
  }
  return `
# Shared weight fridge (Modal Volume "${WEIGHTS_VOLUME_NAME}").
# Cold path: miss at /models/{hash} → download → ${WEIGHTS_VOLUME_VAR}.commit().
# Warm path: file already on volume → skip download (no re-fetch on cold start).
${WEIGHTS_VOLUME_VAR} = modal.Volume.from_name("${WEIGHTS_VOLUME_NAME}", create_if_missing=True)
`;
}

/**
 * `@app.cls(..., volumes={"/models": weights_vol})` fragment, or empty.
 * No volume arg when customModels has no remote paths.
 */
export function formatModalVolumesArg(customModels?: CustomModelRef[]): string {
  if (!needsWeightVolume(customModels)) {
    return '';
  }
  return `,\n    volumes={"${WEIGHTS_MOUNT_PATH}": ${WEIGHTS_VOLUME_VAR}}`;
}

/**
 * Python block injected at the start of `load()`:
 * - os.environ.setdefault for plain env
 * - download-on-miss for s3:// / https custom model paths (shared volume fridge)
 * - AURAOPS_MODEL_PATH for the primary model
 */
export function generateRuntimeBootstrapPython(opts: {
  env?: Record<string, string>;
  customModels?: CustomModelRef[];
  /** Method-body indent (default 8 spaces for class methods). */
  indent?: string;
}): string {
  const indent = opts.indent ?? '        ';
  const envEntries = opts.env ? Object.entries(opts.env) : [];
  const models = (opts.customModels ?? []).filter((m) => Boolean(m?.path));
  const useFridge = needsWeightVolume(opts.customModels);

  if (envEntries.length === 0 && models.length === 0) {
    return '';
  }

  const lines: string[] = [`${indent}import os`];

  for (const [key, value] of envEntries) {
    lines.push(
      `${indent}os.environ.setdefault("${escapePythonString(key)}", "${escapePythonString(value)}")`,
    );
  }

  if (models.length > 0) {
    // Primary model drives AURAOPS_MODEL_PATH; bootstrap each remote path into the fridge.
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const src = escapePythonString(model.path);
      const isS3 = model.path.startsWith('s3://');
      const isHttp =
        model.path.startsWith('https://') || model.path.startsWith('http://');

      lines.push(
        `${indent}# Custom model weight bootstrap: ${escapePythonString(model.name || model.path)}`,
      );
      lines.push(`${indent}_src_${i} = "${src}"`);

      if (isS3 || isHttp) {
        const key = escapePythonString(weightCacheKey(model));
        lines.push(`${indent}_dest_${i} = "${WEIGHTS_MOUNT_PATH}/${key}"`);
        // Warm path: weight already on shared volume — skip download.
        // Cold path: download into /models/{hash}, then commit so later cold starts hit cache.
        lines.push(`${indent}if not os.path.exists(_dest_${i}):`);
        lines.push(`${indent}    try:`);
        if (isS3) {
          lines.push(`${indent}        import boto3`);
          lines.push(`${indent}        os.makedirs("${WEIGHTS_MOUNT_PATH}", exist_ok=True)`);
          lines.push(`${indent}        _parts = _src_${i}[5:].split("/", 1)`);
          lines.push(
            `${indent}        _bucket, _key = _parts[0], (_parts[1] if len(_parts) > 1 else "")`,
          );
          lines.push(
            `${indent}        boto3.client("s3").download_file(_bucket, _key, _dest_${i})`,
          );
          if (useFridge) {
            lines.push(`${indent}        ${WEIGHTS_VOLUME_VAR}.commit()`);
          }
          lines.push(
            `${indent}        print(f"✓ Downloaded s3 weights to {_dest_${i}} (fridge filled)")`,
          );
        } else {
          lines.push(`${indent}        import urllib.request`);
          lines.push(`${indent}        os.makedirs("${WEIGHTS_MOUNT_PATH}", exist_ok=True)`);
          lines.push(`${indent}        urllib.request.urlretrieve(_src_${i}, _dest_${i})`);
          if (useFridge) {
            lines.push(`${indent}        ${WEIGHTS_VOLUME_VAR}.commit()`);
          }
          lines.push(
            `${indent}        print(f"✓ Downloaded HTTP weights to {_dest_${i}} (fridge filled)")`,
          );
        }
        lines.push(`${indent}    except Exception as _werr:`);
        lines.push(
          `${indent}        print(f"⚠ ${isS3 ? 'S3' : 'HTTP'} weight download failed: {_werr}")`,
        );
        lines.push(`${indent}        _dest_${i} = _src_${i}`);
        lines.push(`${indent}else:`);
        lines.push(
          `${indent}    print(f"✓ Weight cache hit at {_dest_${i}} (shared volume fridge)")`,
        );
      } else {
        // Local / cache path already available in the runtime image
        lines.push(`${indent}_dest_${i} = _src_${i}`);
      }

      if (i === 0) {
        lines.push(`${indent}os.environ["AURAOPS_MODEL_PATH"] = _dest_${i}`);
        lines.push(`${indent}print(f"✓ AURAOPS_MODEL_PATH={_dest_${i}}")`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** True when any custom model path needs boto3 at runtime. */
export function needsBoto3ForModels(customModels?: CustomModelRef[]): boolean {
  return (customModels ?? []).some((m) => m.path?.startsWith('s3://'));
}
