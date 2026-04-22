import fs from 'fs/promises';
import path from 'path';
import TOML from 'toml';
import type { ParsedManifest } from '../../types/blueprint.types';
import { ManifestParsingError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export class ManifestParser {
  async parse(projectPath: string): Promise<ParsedManifest> {
    const manifest: ParsedManifest = {
      framework: 'unknown',
      frameworkVersion: '0.0.0',
      pythonVersion: '3.11',
      allDependencies: {},
    };

    const requirementsTxt = await this.tryRead(projectPath, 'requirements.txt');
    const pyprojectToml = await this.tryRead(projectPath, 'pyproject.toml');
    const packageJson = await this.tryRead(projectPath, 'package.json');

    if (requirementsTxt) {
      Object.assign(manifest, this.parseRequirementsTxt(requirementsTxt));
      logger.info('✓ Parsed requirements.txt');
    } else if (pyprojectToml) {
      Object.assign(manifest, this.parsePyprojectToml(pyprojectToml));
      logger.info('✓ Parsed pyproject.toml');
    } else if (packageJson) {
      Object.assign(manifest, this.parsePackageJson(packageJson));
      logger.info('✓ Parsed package.json');
    } else {
      throw new ManifestParsingError(
        'manifest',
        'No recognized manifest file found (requirements.txt, pyproject.toml, or package.json)',
      );
    }

    return manifest;
  }

  private parseRequirementsTxt(content: string): Partial<ParsedManifest> {
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const deps: Record<string, string> = {};

    let pythonVersion = '3.11';
    let torchVersion: string | undefined;
    let langchainVersion: string | undefined;
    let cudaVersion: string | undefined;

    lines.forEach(line => {
      const [name, version] = this.parseLine(line);
      if (!name) return;

      deps[name] = version;
      if (name === 'torch') torchVersion = version;
      if (name === 'langchain') langchainVersion = version;
      if (name.includes('cuda')) cudaVersion = version;
    });

    return {
      pythonVersion,
      allDependencies: deps,
      torchVersion,
      langchainVersion,
      cudaVersion,
    };
  }

  private parsePyprojectToml(content: string): Partial<ParsedManifest> {
    try {
      const parsed = TOML.parse(content);
      const deps = parsed.project?.dependencies || parsed.tool?.poetry?.dependencies || {};

      return {
        pythonVersion: parsed.project?.['requires-python'] || '3.11',
        allDependencies: deps as Record<string, string>,
        torchVersion: deps['torch'] || undefined,
        langchainVersion: deps['langchain'] || undefined,
        cudaVersion: this.extractCudaVersion(deps as Record<string, string>),
      };
    } catch (error) {
      throw new ManifestParsingError('pyproject.toml', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private parsePackageJson(content: string): Partial<ParsedManifest> {
    try {
      const parsed = JSON.parse(content);
      const deps = parsed.dependencies || {};

      return {
        pythonVersion: '3.11',
        allDependencies: deps as Record<string, string>,
      };
    } catch (error) {
      throw new ManifestParsingError('package.json', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private parseLine(line: string): [string, string] {
    const match = line.match(/^([a-zA-Z0-9-_.]+)(.*)/);
    if (!match) return ['', ''];

    const name = match[1].toLowerCase();
    const versionSpec = match[2].trim();

    const cleanVersion = versionSpec
      .replace(/^[<>=!]+/, '')
      .split('[')[0]
      .trim() || 'latest';

    return [name, cleanVersion];
  }

  private extractCudaVersion(deps: Record<string, string>): string | undefined {
    if (deps['torch-cuda']) return deps['torch-cuda'];
    if (deps['tensorflow-gpu']) return this.extractVersionFromSpec(deps['tensorflow-gpu']);
    return undefined;
  }

  private extractVersionFromSpec(spec: string): string | undefined {
    const match = spec.match(/cuda[_-]?(\d+\.\d+)/i);
    return match ? match[1] : undefined;
  }

  private async tryRead(projectPath: string, filename: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(projectPath, filename), 'utf-8');
    } catch {
      return null;
    }
  }
}

export default ManifestParser;
