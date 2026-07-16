import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGenerateLockfile = jest.fn();

jest.mock('../../services/deterministic/dependencyLocking', () => ({
  DependencyLocking: jest.fn().mockImplementation(() => ({
    generateLockfile: mockGenerateLockfile,
  })),
}));

import { initCommand, runInit } from '../init';

describe('CLI: auraops init', () => {
  const fixturesDir = path.resolve(__dirname, '../../../tests/fixtures');
  let tmpDir: string;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-test-'));
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    mockGenerateLockfile.mockReset();
    mockGenerateLockfile.mockRejectedValue(new Error('pip-tools not installed'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should parse pytorch project and generate blueprint', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'torch==2.1.0\ntransformers==4.30.0\nnumpy==1.24.0\n',
    );

    await initCommand.parseAsync(['node', 'auraops', tmpDir]);

    const blueprintPath = path.join(tmpDir, '.auraops', 'blueprint.json');
    const content = await fs.readFile(blueprintPath, 'utf-8');
    const blueprint = JSON.parse(content);

    expect(blueprint.id).toBeDefined();
    expect(blueprint.framework.framework).toBe('transformers');
    expect(blueprint.framework.cudaVersion).toBeDefined();
    expect(blueprint.checksums.blueprintHash).toBeDefined();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Manifest parsed'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Framework detected'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Blueprint generated'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Init complete'));
  });

  it('should parse langchain project as agentic', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'langchain==0.1.0\nlangchain-community==0.1.0\ntorch==2.1.0\n',
    );

    await initCommand.parseAsync(['node', 'auraops', tmpDir]);

    const blueprintPath = path.join(tmpDir, '.auraops', 'blueprint.json');
    const content = await fs.readFile(blueprintPath, 'utf-8');
    const blueprint = JSON.parse(content);

    expect(blueprint.framework.framework).toBe('langchain');
    expect(blueprint.framework.primaryUse).toBe('agentic');
  });

  it('should respect custom output directory', async () => {
    const customOutput = path.join(tmpDir, 'custom-output');
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'torch==2.1.0\n',
    );

    await initCommand.parseAsync(['node', 'auraops', tmpDir, '-o', customOutput]);

    const blueprintPath = path.join(customOutput, 'blueprint.json');
    const content = await fs.readFile(blueprintPath, 'utf-8');
    const blueprint = JSON.parse(content);
    expect(blueprint.id).toBeDefined();
  });

  it('should fail when project path does not exist', async () => {
    await initCommand.parseAsync(['node', 'auraops', '/nonexistent/path']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should fail when no manifest file found', async () => {
    await initCommand.parseAsync(['node', 'auraops', tmpDir]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No recognized manifest'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle pyproject.toml manifests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'pyproject.toml'),
      `[tool.poetry.dependencies]
torch = "2.1.0"
numpy = "1.24.0"
`,
    );

    await runInit(tmpDir, {});

    const blueprintPath = path.join(tmpDir, '.auraops', 'blueprint.json');
    const content = await fs.readFile(blueprintPath, 'utf-8');
    const blueprint = JSON.parse(content);
    expect(blueprint.id).toBeDefined();
  });

  it('should display dependency count in output', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'torch==2.1.0\nnumpy==1.24.0\npandas==2.0.0\n',
    );

    await initCommand.parseAsync(['node', 'auraops', tmpDir]);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('3 dependencies'));
  });

  it('should show framework details in output', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'torch==2.1.0\n',
    );

    await initCommand.parseAsync(['node', 'auraops', tmpDir]);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Framework'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Python'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('CUDA'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Base Image'));
  });

  it('should work when given explicit current directory path', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'torch==2.1.0\n');

    await runInit(tmpDir, {});

    const blueprintPath = path.join(tmpDir, '.auraops', 'blueprint.json');
    const exists = await fs.access(blueprintPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('should classify a real CrewAI fixture as crewai through the full init pipeline', async () => {
    const fixtureDir = path.join(fixturesDir, 'crewai-medium');
    await fs.copyFile(path.join(fixtureDir, 'crew.py'), path.join(tmpDir, 'crew.py'));
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'crewai==0.11.2\nlangchain==0.2.0\nlangchain-core==0.2.0\nlangchain-community==0.2.0\n',
    );

    await runInit(tmpDir, {});

    const blueprintPath = path.join(tmpDir, '.auraops', 'blueprint.json');
    const content = await fs.readFile(blueprintPath, 'utf-8');
    const blueprint = JSON.parse(content);

    expect(blueprint.framework.framework).toBe('crewai');
    expect(blueprint.framework.crewAI).toBeDefined();
    expect(blueprint.framework.crewAI.agentCount).toBe(5);
    expect(blueprint.framework.crewAI.totalToolCount).toBe(9);
    expect(blueprint.framework.crewAI.recommendedGpuTier).toBe('L4');
    expect(blueprint.framework.primaryUse).toBe('agentic');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('CrewAI detected (5 agents, 9 tools)'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Framework detected: crewai'));
  });

  it('should write requirements.lock when pip-compile succeeds', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'torch==2.1.0\n',
    );
    const cachedLock = path.join(tmpDir, 'cached.lock');
    await fs.writeFile(cachedLock, 'torch==2.1.0\n# hash\n');
    mockGenerateLockfile.mockResolvedValue({ lockPath: cachedLock, hash: 'abc' });

    await runInit(tmpDir, {});

    const lockPath = path.join(tmpDir, 'requirements.lock');
    const lockContent = await fs.readFile(lockPath, 'utf-8');
    expect(lockContent).toContain('torch==2.1.0');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Lockfile written'));
    expect(mockGenerateLockfile).toHaveBeenCalledWith(
      path.join(tmpDir, 'requirements.txt'),
      '3.11',
    );
  });

  it('should continue init when dependency locking fails', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      'torch==2.1.0\n',
    );
    mockGenerateLockfile.mockRejectedValue(new Error('pip-tools not installed'));

    await runInit(tmpDir, {});

    const blueprintPath = path.join(tmpDir, '.auraops', 'blueprint.json');
    const exists = await fs.access(blueprintPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dependency locking skipped'),
    );
  });

  it('should generate temp requirements from pyproject deps for locking', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'pyproject.toml'),
      `[tool.poetry.dependencies]
torch = "2.1.0"
numpy = "1.24.0"
`,
    );
    const cachedLock = path.join(tmpDir, 'cached.lock');
    await fs.writeFile(cachedLock, 'torch==2.1.0\nnumpy==1.24.0\n');
    mockGenerateLockfile.mockResolvedValue({ lockPath: cachedLock, hash: 'def' });

    await runInit(tmpDir, {});

    expect(mockGenerateLockfile).toHaveBeenCalled();
    const reqArg = mockGenerateLockfile.mock.calls[0][0] as string;
    expect(reqArg).toContain('_requirements_for_lock.txt');
    const lockExists = await fs
      .access(path.join(tmpDir, 'requirements.lock'))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(true);
  });
});
