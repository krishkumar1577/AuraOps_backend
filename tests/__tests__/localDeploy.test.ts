import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.mock('axios');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/utils/config', () => ({
  config: {
    modal_token_id: '',
    modal_token_secret: '',
  },
}));

const mockDeployApp = jest.fn();
const mockWriteModalApp = jest.fn();
const mockGenerateModalApp = jest.fn();

jest.mock('../../src/services/orchestration/modalAppDeployer', () => ({
  ModalAppDeployer: {
    generateModalApp: (...args: unknown[]) => mockGenerateModalApp(...args),
    writeModalApp: (...args: unknown[]) => mockWriteModalApp(...args),
    deployApp: (...args: unknown[]) => mockDeployApp(...args),
  },
}));

const mockGenerateClaudeDesktopConfig = jest.fn();
const mockSerializeClaudeDesktopConfig = jest.fn();

jest.mock('../../src/services/mcp/mcpCardGenerator', () => ({
  generateClaudeDesktopConfig: (...args: unknown[]) => mockGenerateClaudeDesktopConfig(...args),
  serializeClaudeDesktopConfig: (...args: unknown[]) => mockSerializeClaudeDesktopConfig(...args),
}));

import { runLocalDeploy } from '../../src/cli/localDeploy';

const SAMPLE_BLUEPRINT = {
  id: '11111111-1111-1111-1111-111111111111',
  timestamp: new Date().toISOString(),
  framework: { framework: 'pytorch', version: '2.1.0', cudaVersion: '12.1', pythonVersion: '3.11', primaryUse: 'inference' },
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
  checksums: { allDepsHash: 'abc', blueprintHash: 'def' },
};

const FAKE_ENDPOINT = 'https://workspace--auraops-local.modal.run';

describe('CLI: runLocalDeploy', () => {
  let tmpDir: string;
  let blueprintPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraops-local-deploy-'));
    blueprintPath = path.join(tmpDir, 'blueprint.json');
    await fs.writeFile(blueprintPath, JSON.stringify(SAMPLE_BLUEPRINT));

    mockGenerateModalApp.mockReturnValue('import modal\n# generated app');
    mockWriteModalApp.mockResolvedValue('/tmp/auraops-dep/modal_app_test.py');
    mockDeployApp.mockResolvedValue(FAKE_ENDPOINT);

    mockGenerateClaudeDesktopConfig.mockReturnValue({
      mcpServers: { 'auraops-test': { url: `${FAKE_ENDPOINT}/mcp/tools` } },
    });
    mockSerializeClaudeDesktopConfig.mockReturnValue(
      JSON.stringify(
        { mcpServers: { 'auraops-test': { url: `${FAKE_ENDPOINT}/mcp/tools` } } },
        null,
        2,
      ),
    );

    process.env.MODAL_TOKEN_ID = 'test-token-id';
    process.env.MODAL_TOKEN_SECRET = 'test-token-secret';
  });

  afterEach(async () => {
    jest.clearAllMocks();
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('deploys locally, writes last-deployment.json, and returns a complete LocalDeployResult', async () => {
    const result = await runLocalDeploy({
      blueprint: SAMPLE_BLUEPRINT as any,
      blueprintPath,
      gpuCount: 1,
    });

    expect(mockGenerateModalApp).toHaveBeenCalledTimes(1);
    expect(mockGenerateModalApp).toHaveBeenCalledWith(
      SAMPLE_BLUEPRINT,
      expect.any(String),
      expect.objectContaining({ projectPath: expect.any(String), gpuCount: 1 }),
    );
    expect(mockWriteModalApp).toHaveBeenCalledWith(
      'import modal\n# generated app',
      expect.any(String),
      expect.any(String), // projectPath — packages user code next to modal_app
    );
    expect(mockDeployApp).toHaveBeenCalledWith('/tmp/auraops-dep/modal_app_test.py', expect.any(String));

    expect(result.endpointUrl).toBe(FAKE_ENDPOINT);
    expect(result.deploymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.deployTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.mcpEnabled).toBe(false);
    expect(result.claudeDesktopConfigJson).toBeUndefined();

    const recordPath = path.join(tmpDir, '.auraops', 'last-deployment.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'));
    expect(record.mode).toBe('local');
    expect(record.deploymentId).toBe(result.deploymentId);
    expect(record.endpointUrl).toBe(FAKE_ENDPOINT);
    expect(record.framework).toBe('pytorch');
    expect(record.mcpEnabled).toBe(false);
  });

  it('throws when Modal credentials are missing in non-interactive mode', async () => {
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
    process.env.AURAOPS_NONINTERACTIVE = '1';

    // Jest is non-TTY + NONINTERACTIVE → clear error (no hang on prompt).
    await expect(
      runLocalDeploy({
        blueprint: SAMPLE_BLUEPRINT as any,
        blueprintPath,
        gpuCount: 1,
      }),
    ).rejects.toThrow(/MODAL_TOKEN_ID/);

    await expect(
      runLocalDeploy({
        blueprint: SAMPLE_BLUEPRINT as any,
        blueprintPath,
        gpuCount: 1,
      }),
    ).rejects.toThrow(/MODAL_TOKEN_SECRET|interactive/);

    expect(mockGenerateModalApp).not.toHaveBeenCalled();
    expect(mockWriteModalApp).not.toHaveBeenCalled();
    expect(mockDeployApp).not.toHaveBeenCalled();

    delete process.env.AURAOPS_NONINTERACTIVE;
  });

  it('emits a Claude Desktop MCP config when enableMcp is true', async () => {
    const result = await runLocalDeploy({
      blueprint: SAMPLE_BLUEPRINT as any,
      blueprintPath,
      gpuCount: 1,
      enableMcp: true,
    });

    expect(mockGenerateClaudeDesktopConfig).toHaveBeenCalledTimes(1);
    expect(mockSerializeClaudeDesktopConfig).toHaveBeenCalledTimes(1);
    expect(result.mcpEnabled).toBe(true);
    expect(typeof result.claudeDesktopConfigJson).toBe('string');

    const parsed = JSON.parse(result.claudeDesktopConfigJson!);
    expect(parsed).toHaveProperty('mcpServers');
    expect(Object.keys(parsed.mcpServers).length).toBeGreaterThanOrEqual(1);
    const firstServer = Object.values(parsed.mcpServers)[0] as { url: string };
    expect(firstServer.url).toMatch(/^https?:\/\//);
  });

  it('passes gpuCount and enableMcp through to ModalAppDeployer.generateModalApp', async () => {
    await runLocalDeploy({
      blueprint: SAMPLE_BLUEPRINT as any,
      blueprintPath,
      gpuCount: 4,
      enableMcp: true,
    });

    expect(mockGenerateModalApp).toHaveBeenCalledTimes(1);
    const genArgs = mockGenerateModalApp.mock.calls[0];
    expect(genArgs[0]).toEqual(SAMPLE_BLUEPRINT);
    expect(genArgs[1]).toEqual(expect.any(String));
    expect(genArgs[2]).toEqual(
      expect.objectContaining({ gpuCount: 4, enableMcp: true }),
    );
  });
});
