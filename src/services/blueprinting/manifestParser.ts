import fs from 'fs/promises';
import path from 'path';
import TOML from 'toml';
import YAML from 'yaml';
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
    const environmentYml = await this.tryRead(projectPath, 'environment.yml') || await this.tryRead(projectPath, 'conda.yaml');
    const packageJson = await this.tryRead(projectPath, 'package.json');

    if (requirementsTxt) {
      Object.assign(manifest, this.parseRequirementsTxt(requirementsTxt));
      logger.info('✓ Parsed requirements.txt');
    } else if (pyprojectToml) {
      Object.assign(manifest, this.parsePyprojectToml(pyprojectToml));
      logger.info('✓ Parsed pyproject.toml');
    } else if (environmentYml) {
      Object.assign(manifest, this.parseCondaYaml(environmentYml));
      logger.info('✓ Parsed Conda environment file');
    } else if (packageJson) {
      Object.assign(manifest, this.parsePackageJson(packageJson));
      logger.info('✓ Parsed package.json');
    } else {
      logger.warn('! No manifest file found. Attempting automatic inference from source code...');
      Object.assign(manifest, await this.inferFromSource(projectPath));
      
      if (Object.keys(manifest.allDependencies).length === 0) {
        throw new ManifestParsingError(
          'manifest',
          'No recognized manifest file found and no dependencies could be inferred from source code.',
        );
      }
      logger.info(`✓ Inferred ${Object.keys(manifest.allDependencies).length} dependencies from source code`);
    }

    manifest.systemDependencies = this.identifySystemDependencies(manifest.allDependencies);
    if (manifest.systemDependencies.length > 0) {
      logger.info(`✓ Identified ${manifest.systemDependencies.length} system dependencies: ${manifest.systemDependencies.join(', ')}`);
    }

    return manifest;
  }

  private identifySystemDependencies(deps: Record<string, string>): string[] {
    const systemDeps = new Set<string>();
    
    // Mapping: Python package -> [System packages]
    const mapping: Record<string, string[]> = {
      'opencv-python': ['libgl1', 'libglib2.0-0'],
      'opencv-contrib-python': ['libgl1', 'libglib2.0-0'],
      'ffmpeg-python': ['ffmpeg'],
      'psycopg2': ['libpq-dev'],
      'pyyaml': ['libyaml-dev'],
      'pillow': ['libjpeg-dev', 'zlib1g-dev'],
      'scipy': ['libatlas-base-dev'],
    };

    Object.keys(deps).forEach(pkg => {
      const normalizedPkg = pkg.toLowerCase();
      if (mapping[normalizedPkg]) {
        mapping[normalizedPkg].forEach(sd => systemDeps.add(sd));
      }
    });

    return Array.from(systemDeps);
  }

  private async inferFromSource(projectPath: string): Promise<Partial<ParsedManifest>> {
    const deps: Record<string, string> = {};
    const pythonFiles = await this.scanDirectory(projectPath);
    logger.info(`Ghost Scanner: Found ${pythonFiles.length} Python files`);
    
    // Common mappings from import name to package name
    const packageMap: Record<string, string> = {
      'sklearn': 'scikit-learn',
      'cv2': 'opencv-python',
      'yaml': 'pyyaml',
      'PIL': 'Pillow',
      'transformers': 'transformers',
      'torch': 'torch',
      'langchain': 'langchain',
      'numpy': 'numpy',
      'pandas': 'pandas',
      'tensorflow': 'tensorflow',
      'jax': 'jax',
    };

    for (const file of pythonFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const imports = this.extractImports(content);
        logger.info(`Ghost Scanner: Extracted ${imports.length} imports from ${path.basename(file)}`);
        
        imports.forEach(imp => {
          const packageName = packageMap[imp] || imp;
          if (!this.isStandardLibrary(packageName)) {
            deps[packageName] = 'latest';
          }
        });
      } catch (err) {
        logger.warn(`Failed to read file for inference: ${file}`);
      }
    }

    return {
      pythonVersion: '3.11',
      allDependencies: deps,
      torchVersion: deps['torch'] ? 'latest' : undefined,
      langchainVersion: deps['langchain'] ? 'latest' : undefined,
      cudaVersion: this.extractCudaVersion(deps),
    };
  }

  private async scanDirectory(dir: string): Promise<string[]> {
    const results: string[] = [];
    const list = await fs.readdir(dir, { withFileTypes: true });

    for (const item of list) {
      const res = path.resolve(dir, item.name);
      if (item.isDirectory()) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'venv' || item.name === 'model') continue;
        results.push(...(await this.scanDirectory(res)));
      } else if (item.name.endsWith('.py')) {
        results.push(res);
      }
    }

    return results;
  }

  private extractImports(content: string): string[] {
    const imports = new Set<string>();
    
    // Looser regex to catch more variations
    const importRegex = /(?:^|\n)\s*import\s+([a-zA-Z0-9_]+)/g;
    const fromImportRegex = /(?:^|\n)\s*from\s+([a-zA-Z0-9_]+)/g;

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      imports.add(match[1]);
    }
    while ((match = fromImportRegex.exec(content)) !== null) {
      imports.add(match[1]);
    }

    return Array.from(imports);
  }

  private isStandardLibrary(pkg: string): boolean {
    const stdLib = new Set([
      'os', 'sys', 'path', 'time', 'datetime', 'json', 're', 'math', 
      'random', 'collections', 'itertools', 'functools', 'abc', 
      'typing', 'io', 'shutil', 'glob', 'subprocess', 'threading', 
      'multiprocessing', 'argparse', 'logging', 'pickle', 'copy'
    ]);
    return stdLib.has(pkg);
  }

  private parseRequirementsTxt(content: string): Partial<ParsedManifest> {
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const deps: Record<string, string> = {};

    const pythonVersion = '3.11';
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

  private parseCondaYaml(content: string): Partial<ParsedManifest> {
    try {
      const parsed = YAML.parse(content);
      const deps: Record<string, string> = {};
      let pythonVersion = '3.11';

      if (parsed.dependencies && Array.isArray(parsed.dependencies)) {
        parsed.dependencies.forEach((dep: string | Record<string, string[]>) => {
          if (typeof dep === 'string') {
            const [name, version] = dep.split(/[=><]+/);
            if (name === 'python') {
              pythonVersion = version || '3.11';
            } else {
              deps[name] = version || 'latest';
            }
          } else if (typeof dep === 'object' && dep.pip) {
            // Handle pip dependencies inside conda yaml
            dep.pip.forEach((pipDep: string) => {
              const [name, version] = this.parseLine(pipDep);
              if (name) deps[name] = version;
            });
          }
        });
      }

      return {
        pythonVersion,
        allDependencies: deps,
        torchVersion: deps['torch'] || undefined,
        langchainVersion: deps['langchain'] || undefined,
        cudaVersion: this.extractCudaVersion(deps),
      };
    } catch (error) {
      throw new ManifestParsingError('environment.yml', error instanceof Error ? error.message : 'Unknown error');
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

