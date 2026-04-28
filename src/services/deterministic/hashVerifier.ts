import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import { DeploymentError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface EnvironmentFingerprint {
  osType: string;
  osRelease: string;
  pythonVersion: string;
  packageCount: number;
  dependencyHash: string;
  timestamp: number;
}

export class HashVerifier {
  async hashEnvironment(lockPath: string): Promise<string> {
    const start = Date.now();

    try {
      if (!lockPath || typeof lockPath !== 'string') {
        throw new ValidationError('Invalid lock file path', { lockPath });
      }

      const lockContent = await this.readLockFile(lockPath);
      const fingerprint = await this.getFingerprintmetadata(lockPath);

      const combined = JSON.stringify({
        osType: fingerprint.osType,
        osRelease: fingerprint.osRelease,
        pythonVersion: fingerprint.pythonVersion,
        packageCount: fingerprint.packageCount,
        lockContent,
      });

      const hash = crypto.createHash('sha256').update(combined).digest('hex');

      logger.info(`✓ Environment hash generated in ${Date.now() - start}ms`);

      return hash;
    } catch (error: unknown) {
      if (error instanceof ValidationError) {
        throw error;
      }

      throw this.toDeploymentError('Failed to hash environment', { lockPath }, error);
    }
  }

  async verifyLockfile(lockPath: string, expectedHash: string): Promise<boolean> {
    const start = Date.now();

    try {
      if (!lockPath || typeof lockPath !== 'string') {
        throw new ValidationError('Invalid lock file path', { lockPath });
      }

      if (!expectedHash || typeof expectedHash !== 'string') {
        throw new ValidationError('Invalid expected hash', { expectedHash });
      }

      const actualHash = await this.hashEnvironment(lockPath);
      const isValid = actualHash === expectedHash;

      logger.info(
        `✓ Lock file verification ${isValid ? 'passed' : 'failed'} in ${Date.now() - start}ms`,
      );

      return isValid;
    } catch (error: unknown) {
      if (error instanceof ValidationError || error instanceof DeploymentError) {
        throw error;
      }

      throw this.toDeploymentError('Failed to verify lock file', { lockPath, expectedHash }, error);
    }
  }

  async getFingerprintmetadata(lockPath: string): Promise<EnvironmentFingerprint> {
    const start = Date.now();

    try {
      if (!lockPath || typeof lockPath !== 'string') {
        throw new ValidationError('Invalid lock file path', { lockPath });
      }

      const lockContent = await this.readLockFile(lockPath);
      const packageCount = this.countPackages(lockContent);

      const osType = os.type();
      const osRelease = os.release();
      const pythonVersion = this.extractPythonVersion(lockContent);

      const dependencyHash = crypto
        .createHash('sha256')
        .update(lockContent)
        .digest('hex');

      const fingerprint: EnvironmentFingerprint = {
        osType,
        osRelease,
        pythonVersion,
        packageCount,
        dependencyHash,
        timestamp: Date.now(),
      };

      logger.info(
        `✓ Fingerprint metadata generated in ${Date.now() - start}ms (${packageCount} packages)`,
      );

      return fingerprint;
    } catch (error: unknown) {
      if (error instanceof ValidationError) {
        throw error;
      }

      throw this.toDeploymentError('Failed to generate fingerprint metadata', { lockPath }, error);
    }
  }

  private async readLockFile(lockPath: string): Promise<string> {
    try {
      const content = await fs.readFile(lockPath, 'utf-8');

      if (!content || content.trim().length === 0) {
        throw new ValidationError('Lock file is empty', { lockPath });
      }

      return content;
    } catch (error: unknown) {
      if (error instanceof ValidationError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('ENOENT')) {
        throw new ValidationError('Lock file not found', { lockPath });
      }

      if (message.includes('EACCES')) {
        throw new ValidationError('Lock file permission denied', { lockPath });
      }

      throw this.toDeploymentError('Failed to read lock file', { lockPath }, error);
    }
  }

  private countPackages(lockContent: string): number {
    if (!lockContent) {
      return 0;
    }

    const lines = lockContent.split('\n');
    let count = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      if (trimmed.includes('==') || trimmed.includes('@') || trimmed.includes('git+')) {
        count += 1;
      }
    }

    return count;
  }

  private extractPythonVersion(lockContent: string): string {
    const lines = lockContent.split('\n');

    for (const line of lines) {
      if (
        line.includes('Python-Version') ||
        line.includes('python_version') ||
        line.includes('pythonVersion')
      ) {
        const parts = line.split(/[=:]/);
        const version = parts[parts.length - 1].trim();

        if (version && /^\d+\.\d+/.test(version)) {
          return version;
        }
      }
    }

    return '3.10';
  }

  private toDeploymentError(
    message: string,
    details: Record<string, unknown>,
    cause: unknown,
  ): DeploymentError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new DeploymentError(message, { ...details, cause: causeMessage });
  }
}

export default HashVerifier;
