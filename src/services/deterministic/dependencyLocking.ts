import { execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DeploymentError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface LockfileResult {
  lockPath: string;
  hash: string;
}

interface LockfileGenerationOptions {
  cacheDir?: string;
  pythonVersion?: string;
}

interface LockfileMetadata {
  pythonVersion: string;
  generatedAt: number;
  sourceHash: string;
  requirementsPath: string;
}

const DEFAULT_CACHE_DIR = path.join(process.cwd(), '.lock-cache');
const SUPPORTED_PYTHON_VERSIONS = ['3.9', '3.10', '3.11', '3.12'];

export class DependencyLocking {
  private readonly cacheDir: string;

  constructor(options?: LockfileGenerationOptions) {
    this.cacheDir = options?.cacheDir ?? DEFAULT_CACHE_DIR;
    this.ensureCacheDir();
  }

  async generateLockfile(
    requirementsPath: string,
    pythonVersion: string,
  ): Promise<LockfileResult> {
    const start = Date.now();

    try {
      this.validateInputs(requirementsPath, pythonVersion);

      const sourceFileContent = fs.readFileSync(requirementsPath, 'utf-8');
      this.validateRequirementsFile(sourceFileContent);

      const sourceHash = this.computeHash(sourceFileContent);
      const cacheKey = this.generateCacheKey(sourceHash, pythonVersion);
      const cachedLockfile = path.join(this.cacheDir, `${cacheKey}.lock`);
      const cachedMetadata = path.join(this.cacheDir, `${cacheKey}.meta.json`);

      if (fs.existsSync(cachedLockfile) && fs.existsSync(cachedMetadata)) {
        logger.info(
          `✓ Using cached lockfile for ${path.basename(requirementsPath)} (Python ${pythonVersion}) (${Date.now() - start}ms)`,
        );
        const lockHash = this.computeFileHash(cachedLockfile);
        return {
          lockPath: cachedLockfile,
          hash: lockHash,
        };
      }

      logger.info(`Generating lockfile for ${path.basename(requirementsPath)} (Python ${pythonVersion})...`);

      const tempDir = fs.mkdtempSync(path.join(this.cacheDir, 'temp-'));
      const tempLockfile = path.join(tempDir, 'requirements.lock');

      try {
        this.runPipCompile(requirementsPath, tempLockfile, pythonVersion);

        if (!fs.existsSync(tempLockfile)) {
          throw new DeploymentError('pip-compile did not generate lockfile', {
            requirementsPath,
            pythonVersion,
          });
        }

        const lockfileContent = fs.readFileSync(tempLockfile, 'utf-8');
        this.validateLockfileOutput(lockfileContent);

        fs.writeFileSync(cachedLockfile, lockfileContent, 'utf-8');

        const metadata: LockfileMetadata = {
          pythonVersion,
          generatedAt: Date.now(),
          sourceHash,
          requirementsPath,
        };
        fs.writeFileSync(cachedMetadata, JSON.stringify(metadata, null, 2), 'utf-8');

        const lockHash = this.computeFileHash(cachedLockfile);

        logger.info(
          `✓ Lockfile generated successfully (${Date.now() - start}ms): ${cachedLockfile}`,
        );

        return {
          lockPath: cachedLockfile,
          hash: lockHash,
        };
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    } catch (error: unknown) {
      if (error instanceof ValidationError || error instanceof DeploymentError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Lockfile generation failed (${Date.now() - start}ms): ${errorMessage}`);

      throw new DeploymentError('Failed to generate lockfile', {
        requirementsPath,
        pythonVersion,
        cause: errorMessage,
      });
    }
  }

  private validateInputs(requirementsPath: string, pythonVersion: string): void {
    if (!requirementsPath || typeof requirementsPath !== 'string') {
      throw new ValidationError('requirementsPath must be a non-empty string');
    }

    if (!pythonVersion || typeof pythonVersion !== 'string') {
      throw new ValidationError('pythonVersion must be a non-empty string');
    }

    if (!SUPPORTED_PYTHON_VERSIONS.includes(pythonVersion)) {
      throw new ValidationError(
        `pythonVersion must be one of: ${SUPPORTED_PYTHON_VERSIONS.join(', ')}`,
        { pythonVersion, supported: SUPPORTED_PYTHON_VERSIONS },
      );
    }

    if (!fs.existsSync(requirementsPath)) {
      throw new ValidationError('Requirements file not found', { path: requirementsPath });
    }

    const stats = fs.statSync(requirementsPath);
    if (!stats.isFile()) {
      throw new ValidationError('requirementsPath must be a file', { path: requirementsPath });
    }
  }

  private validateRequirementsFile(content: string): void {
    if (!content || content.trim().length === 0) {
      throw new ValidationError('Requirements file is empty');
    }

    const lines = content.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
    if (lines.length === 0) {
      throw new ValidationError('Requirements file contains no actual dependencies (only comments)');
    }
  }

  private validateLockfileOutput(content: string): void {
    if (!content || content.trim().length === 0) {
      throw new DeploymentError('Generated lockfile is empty');
    }

    const lines = content.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
    if (lines.length === 0) {
      throw new DeploymentError('Generated lockfile contains no actual dependencies');
    }
  }

  private runPipCompile(
    requirementsPath: string,
    outputPath: string,
    pythonVersion: string,
  ): void {
    const pythonExecutable = this.getPythonExecutable(pythonVersion);

    try {
      execSync(
        `${pythonExecutable} -m piptools compile --no-emit-index-url --output-file="${outputPath}" "${requirementsPath}" 2>&1`,
        {
          stdio: 'pipe',
          encoding: 'utf-8',
        },
      );
    } catch (error: unknown) {
      const errorOutput = error instanceof Error ? error.message : String(error);

      if (errorOutput.includes('No module named piptools')) {
        throw new DeploymentError(
          `pip-tools not installed for Python ${pythonVersion}. Install with: ${pythonExecutable} -m pip install pip-tools`,
          { pythonVersion, pythonExecutable },
        );
      }

      throw new DeploymentError('pip-compile execution failed', {
        pythonVersion,
        pythonExecutable,
        cause: errorOutput,
      });
    }
  }

  private getPythonExecutable(pythonVersion: string): string {
    const candidates = [`python${pythonVersion}`, 'python3', 'python'];

    for (const candidate of candidates) {
      try {
        const output = execSync(`${candidate} --version 2>&1`, {
          stdio: 'pipe',
          encoding: 'utf-8',
        }).trim();

        if (output.includes(pythonVersion) || pythonVersion === '3.9' || pythonVersion === '3.10') {
          return candidate;
        }
      } catch {
        // Try next candidate
      }
    }

    throw new DeploymentError(`Python ${pythonVersion} not found in system PATH`, {
      pythonVersion,
      candidates,
    });
  }

  private generateCacheKey(sourceHash: string, pythonVersion: string): string {
    return `lock-${sourceHash.substring(0, 16)}-py${pythonVersion.replace('.', '')}`;
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private computeFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath, 'utf-8');
    return this.computeHash(content);
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.info(`✓ Created lock cache directory: ${this.cacheDir}`);
    }
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  clearCache(): void {
    if (fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      this.ensureCacheDir();
      logger.info(`✓ Cache cleared: ${this.cacheDir}`);
    }
  }
}

export default DependencyLocking;
