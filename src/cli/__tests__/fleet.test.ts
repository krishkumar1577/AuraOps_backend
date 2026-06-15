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

import { fleetCommand, runFleetDeploy } from '../fleet';

describe('CLI: auraops fleet', () => {
  let tmpDir: string;
  let stdoutSpy: jest.SpyInstance;
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-fleet-'));
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should deploy all agents from crew.yaml', async () => {
    await fs.mkdir(path.join(tmpDir, '.auraops'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.auraops', 'blueprint.json'),
      JSON.stringify(sampleBlueprint),
    );

    const crewYaml = `
name: test-crew
agents:
  - name: agent-a
  - name: agent-b
tasks:
  - description: Task one
    agent: agent-a
  - description: Task two
    agent: agent-b
`;
    const crewPath = path.join(tmpDir, 'crew.yaml');
    await fs.writeFile(crewPath, crewYaml);

    mockedAxios.post.mockResolvedValue({
      data: {
        deploymentId: 'dep-fleet-001',
        endpoint_url: 'https://example.modal.run',
      },
    });

    await runFleetDeploy({ fleet: crewPath });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('test-crew'));
  });

  it('should parse fleet command with crew file argument', async () => {
    await fs.mkdir(path.join(tmpDir, '.auraops'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.auraops', 'blueprint.json'),
      JSON.stringify(sampleBlueprint),
    );

    const crewPath = path.join(tmpDir, 'crew.yaml');
    await fs.writeFile(
      crewPath,
      `name: solo-crew
agents:
  - name: solo
tasks:
  - description: Run solo
    agent: solo
`,
    );

    mockedAxios.post.mockResolvedValueOnce({
      data: { deploymentId: 'dep-solo', endpoint_url: 'https://solo.modal.run' },
    });

    await fleetCommand.parseAsync(['node', 'auraops', crewPath]);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
