import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.mock('axios');
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

import { deployCommand } from '../deploy';

describe('CLI: auraops deploy', () => {
  let tmpDir: string;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  const sampleBlueprint = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: new Date().toISOString(),
    framework: {
      framework: 'pytorch',
      version: '2.1.0',
      cudaVersion: '12.1',
      pythonVersion: '3.11',
      primaryUse: 'inference',
    },
    dependencyLock: { torch: '2.1.0' },
    systemRequirements: {
      pythonVersion: '3.11',
      cudaVersion: '12.1',
      cuDNNVersion: '8.9.0',
      baseImageId: 'aura-pytorch-2.1-cuda-12.1',
      baseImageTag: 'latest',
    },
    customModels: [],
    deploymentConfig: {
      entrypoint: 'python main.py',
      runtime: 'python',
      memoryMB: 4096,
      gpuRequired: true,
      gpuMemoryGB: 8,
    },
    checksums: {
      allDepsHash: 'abc123',
      blueprintHash: 'def456',
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-deploy-'));
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    deployCommand.setOptionValueWithSource('gpus', undefined, 'default');
    jest.clearAllMocks();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should deploy with explicit blueprint path', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: 'dep-001',
        agentId: 'agent-001',
        workerId: 'worker-001',
        status: 'running',
        estimatedTime: 26800,
        endpoint_url: 'https://workspace--auraops-dep-001.modal.run',
        endpoint_status: 'live',
      },
    });

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/deploy'),
      expect.objectContaining({
        blueprintId: sampleBlueprint.id,
      }),
      expect.any(Object),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Blueprint validated'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Agent live'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Deployed'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Endpoint'));
  });

  it('should show deployment details after success', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        deploymentId: 'dep-002',
        agentId: 'agent-002',
        status: 'running',
        estimatedTime: 15000,
        endpoint_url: 'https://workspace--auraops-dep-002.modal.run',
        endpoint_status: 'live',
      },
    });

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('dep-002'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('agent-002'));
  });

  it('should fail when blueprint file not found', async () => {
    await deployCommand.parseAsync(['node', 'auraops', '-b', '/nonexistent/blueprint.json']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load blueprint'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle server connection refused', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    const axiosError = new Error('connect ECONNREFUSED') as Error & {
      isAxiosError: boolean;
      code: string;
    };
    axiosError.isAxiosError = true;
    axiosError.code = 'ECONNREFUSED';
    mockedAxios.post.mockRejectedValueOnce(axiosError);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot connect'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle API error response', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    const axiosError = new Error('Request failed') as Error & {
      isAxiosError: boolean;
      response: { data: { error: string }; status: number };
    };
    axiosError.isAxiosError = true;
    axiosError.response = {
      data: { error: 'No available workers' },
      status: 409,
    };
    mockedAxios.post.mockRejectedValueOnce(axiosError);
    mockedAxios.isAxiosError.mockReturnValue(true);

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No available workers'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should send gpuCount when --gpus is specified', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        deploymentId: 'dep-multi',
        agentId: 'agent-multi',
        status: 'running',
        estimatedTime: 25000,
        endpoint_url: 'https://workspace--auraops-dep-multi.modal.run',
        endpoint_status: 'live',
      },
    });

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath, '--gpus', '4']);

    const lastCall = mockedAxios.post.mock.lastCall;
    expect(lastCall).toBeDefined();
    const payload = lastCall![1] as Record<string, unknown>;
    expect(payload.gpuCount).toBe(4);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('GPUs'));
  });

  it('should default gpuCount to 1', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        deploymentId: 'dep-single',
        agentId: 'agent-single',
        status: 'running',
        estimatedTime: 25000,
        endpoint_url: 'https://workspace--auraops-dep-single.modal.run',
        endpoint_status: 'live',
      },
    });

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);

    const lastCall = mockedAxios.post.mock.lastCall;
    expect(lastCall).toBeDefined();
    const payload = lastCall![1] as Record<string, unknown>;
    expect(payload.gpuCount).toBe(1);
  });

  it('should reject invalid --gpus value', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath, '--gpus', '12']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('GPU count must be'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should send correct GPU requirements', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        deploymentId: 'dep-004',
        agentId: 'agent-004',
        status: 'running',
        estimatedTime: 25000,
        endpoint_url: 'https://workspace--auraops-dep-004.modal.run',
        endpoint_status: 'live',
      },
    });

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);

    const lastCall = mockedAxios.post.mock.lastCall;
    expect(lastCall).toBeDefined();
    const payload = lastCall![1] as Record<string, unknown>;
    const gpuReqs = payload.gpuRequirements as Record<string, unknown>;
    expect(gpuReqs.minMemory).toBe(8);
    expect(gpuReqs.framework).toBe('pytorch');
    expect(gpuReqs.pythonVersion).toBe('3.11');
  });

  it('should poll for endpoint url when not returned immediately', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        deploymentId: 'dep-005',
        agentId: 'agent-005',
        status: 'deploying',
        estimatedTime: 25000,
      },
    });
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        endpointUrl: 'https://workspace--auraops-dep-005.modal.run',
        endpoint_status: 'live',
      },
    });

    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

    try {
      await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath]);
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/deployment/dep-005'),
      expect.any(Object),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting for live endpoint'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Endpoint'));
  });

  it('should print Claude Desktop MCP config when --mcp is set', async () => {
    const blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(sampleBlueprint));

    const claudeConfig = JSON.stringify({
      mcpServers: {
        'auraops-test': {
          url: 'https://workspace--auraops-dep.modal.run/mcp/tools',
        },
      },
    }, null, 2);

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        deploymentId: '550e8400-e29b-41d4-a716-446655440000',
        agentId: 'agent-mcp',
        status: 'running',
        endpoint_url: 'https://workspace--auraops-dep.modal.run',
        mcp_enabled: true,
        claude_desktop_config_json: claudeConfig,
      },
    });

    await deployCommand.parseAsync(['node', 'auraops', '-b', blueprintPath, '--mcp']);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ enableMcp: true }),
      expect.any(Object),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('MCP server ready'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('/mcp/tools'));
  });
});
