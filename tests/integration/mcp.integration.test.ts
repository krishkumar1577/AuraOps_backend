/**
 * Task 2A-5: MCP integration tests
 * End-to-end: deploy --mcp → card discovery → Claude Desktop config
 */
import { deploymentRoutes } from '../../src/api/routes/deployment.routes';
import { Orchestrator, type DeploymentRecord } from '../../src/services/orchestration';
import { ModalAppDeployer } from '../../src/services/orchestration/modalAppDeployer';
import {
  generateMcpServerCard,
  McpServerCardSchema,
  ClaudeDesktopConfigSchema,
  serializeClaudeDesktopConfig,
} from '../../src/services/mcp/mcpCardGenerator';
import type { BlueprintJSON } from '../../src/types/blueprint.types';

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/swr/redisClient', () => ({
  RedisWeightRegistry: jest.fn().mockImplementation(() => ({
    getWeightCache: jest.fn().mockResolvedValue(null),
    setWeightCache: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/services/swr/imageLayerCache', () => ({
  ImageLayerCache: jest.fn().mockImplementation(() => ({
    lookup: jest.fn().mockResolvedValue(null),
    register: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/services/telemetry/deployTelemetry', () => ({
  deployTelemetry: { trackEventAsync: jest.fn(), trackContact: jest.fn() },
}));

const ENDPOINT = 'https://workspace--auraops-echo.modal.run';
const DEPLOYMENT_ID = '550e8400-e29b-41d4-a716-446655440099';

const echoBlueprint: BlueprintJSON = {
  id: '550e8400-e29b-41d4-a716-446655440099',
  timestamp: new Date().toISOString(),
  framework: {
    framework: 'langchain',
    version: '0.1.0',
    cudaVersion: '12.1',
    pythonVersion: '3.11',
    primaryUse: 'agentic',
  },
  dependencyLock: { fastapi: '0.110.0' },
  systemRequirements: {
    pythonVersion: '3.11',
    cudaVersion: '12.1',
    cuDNNVersion: '8.6',
    baseImageId: 'python',
    baseImageTag: '3.11-slim',
    systemPackages: [],
  },
  customModels: [],
  deploymentConfig: {
    entrypoint: 'test_agent.py',
    runtime: 'python',
    memoryMB: 4096,
    gpuRequired: true,
    gpuMemoryGB: 8,
  },
  checksums: { allDepsHash: 'sha256-echo', blueprintHash: 'sha256-echo-bp' },
};

describe('MCP Integration (Task 2A-5)', () => {
  let mockFastify: Record<string, unknown>;
  let mockOrchestrator: jest.Mocked<Partial<Orchestrator>>;
  let mockReply: { code: jest.Mock; send: jest.Mock; header: jest.Mock };
  let deploymentStore: Map<string, DeploymentRecord>;
  let deployHandler: (req: unknown, reply: unknown) => Promise<void>;
  let mcpCardHandler: (req: unknown, reply: unknown) => Promise<void>;
  let mcpConfigHandler: (req: unknown, reply: unknown) => Promise<void>;
  let wellKnownHandler: (req: unknown, reply: unknown) => Promise<void>;

  beforeEach(async () => {
    jest.clearAllMocks();
    deploymentStore = new Map();

    mockOrchestrator = {
      deployPersistentModal: jest.fn().mockResolvedValue({
        endpointUrl: ENDPOINT,
        appName: 'auraops-echo',
        imageRef: 'auraops-echo',
        deploymentTime: 4100,
      }),
      saveDeploymentRecord: jest.fn(async (record: DeploymentRecord) => {
        deploymentStore.set(record.deploymentId, record);
      }),
      getDeploymentRecord: jest.fn(async (id: string) => deploymentStore.get(id) ?? null),
      listDeploymentRecords: jest.fn(async () => Array.from(deploymentStore.values())),
      stopPersistentModal: jest.fn(),
      terminateAgent: jest.fn(),
    };

    mockReply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn(),
      header: jest.fn().mockReturnThis(),
    };

    mockFastify = {
      post: jest.fn((route: string, handler: unknown) => {
        mockFastify[`_post_${route}`] = handler;
      }),
      get: jest.fn((route: string, handler: unknown) => {
        mockFastify[`_get_${route}`] = handler;
      }),
      delete: jest.fn(),
    };

    await deploymentRoutes(mockFastify as never, mockOrchestrator as Orchestrator);
    deployHandler = mockFastify['_post_/api/v1/deploy'] as typeof deployHandler;
    mcpCardHandler = mockFastify['_get_/api/v1/deployment/:deploymentId/mcp/card'] as typeof mcpCardHandler;
    mcpConfigHandler = mockFastify['_get_/api/v1/deployment/:deploymentId/mcp/config'] as typeof mcpConfigHandler;
    wellKnownHandler = mockFastify['_get_/.well-known/mcp/:deploymentId.json'] as typeof wellKnownHandler;
  });

  const deployBody = {
    blueprintId: echoBlueprint.id,
    blueprintJson: echoBlueprint,
    lockfilePath: '',
    environmentHash: 'sha256-echo',
    gpuRequirements: {
      minMemory: 8,
      framework: 'langchain',
      pythonVersion: '3.11',
    },
    enableMcp: true,
  };

  it('1. deploy with enableMcp succeeds', async () => {
    await deployHandler({ body: deployBody, user: { email: 'test@example.com' } }, mockReply);
    expect(mockReply.code).toHaveBeenCalledWith(201);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, mcp_enabled: true }),
    );
  });

  it('2. deploy response includes valid JSON MCP card', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const response = mockReply.send.mock.calls[0][0];
    expect(response.mcp_card).toBeDefined();
    expect(() => McpServerCardSchema.parse(response.mcp_card)).not.toThrow();
    expect(JSON.parse(JSON.stringify(response.mcp_card))).toEqual(response.mcp_card);
  });

  it('3. MCP card URLs match endpoint host', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const card = mockReply.send.mock.calls[0][0].mcp_card;
    expect(card.transport.base_url).toBe(ENDPOINT);
    expect(card.transport.tools_list).toBe(`${ENDPOINT}/mcp/tools`);
    expect(card.transport.tools_call).toBe(`${ENDPOINT}/mcp/tools/call`);
  });

  it('4. GET /mcp/card returns stored card', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const { deploymentId } = mockReply.send.mock.calls[0][0];
    await mcpCardHandler({ params: { deploymentId } }, mockReply);
    expect(mockReply.code).toHaveBeenCalledWith(200);
    const card = mockReply.send.mock.calls.at(-1)?.[0];
    expect(card.deployment_id).toBe(deploymentId);
  });

  it('5. /.well-known/mcp discovery returns card without auth', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const { deploymentId } = mockReply.send.mock.calls[0][0];
    await wellKnownHandler({ params: { deploymentId } }, mockReply);
    expect(mockReply.code).toHaveBeenCalledWith(200);
    expect(mockReply.header).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  it('6. GET /mcp/config returns Claude Desktop config', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const { deploymentId } = mockReply.send.mock.calls[0][0];
    await mcpConfigHandler({ params: { deploymentId } }, mockReply);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        config: expect.any(Object),
        config_json: expect.any(String),
      }),
    );
  });

  it('7. Claude Desktop config is valid copy-paste JSON', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const { deploymentId } = mockReply.send.mock.calls[0][0];
    await mcpConfigHandler({ params: { deploymentId } }, mockReply);
    const { config_json } = mockReply.send.mock.calls.at(-1)?.[0];
    const parsed = JSON.parse(config_json);
    expect(() => ClaudeDesktopConfigSchema.parse(parsed)).not.toThrow();
    expect(parsed.mcpServers).toBeDefined();
  });

  it('8. Claude Desktop config URL points to /mcp/tools', async () => {
    await deployHandler({ body: deployBody, user: {} }, mockReply);
    const configJson = mockReply.send.mock.calls[0][0].claude_desktop_config_json;
    const parsed = JSON.parse(configJson);
    const key = Object.keys(parsed.mcpServers)[0];
    expect(parsed.mcpServers[key].url).toBe(`${ENDPOINT}/mcp/tools`);
  });

  it('9. deploy without enableMcp returns null mcp_card', async () => {
    await deployHandler(
      { body: { ...deployBody, enableMcp: false }, user: {} },
      mockReply,
    );
    const response = mockReply.send.mock.calls[0][0];
    expect(response.mcp_enabled).toBe(false);
    expect(response.mcp_card).toBeNull();
  });

  it('10. Modal app generation includes unified MCP ASGI routes', () => {
    const code = ModalAppDeployer.generateModalApp(echoBlueprint, 'dep-echo', {
      enableMcp: true,
    });
    expect(code).toContain('@modal.asgi_app()');
    expect(code).toContain('/mcp/health');
    expect(code).toContain('/mcp/tools');
    expect(code).toContain('/mcp/tools/call');
    expect(code).not.toContain('@modal.fastapi_endpoint');
  });
});

describe('MCP card unit validation', () => {
  it('should round-trip card JSON for copy-paste clients', () => {
    const card = generateMcpServerCard({
      deploymentId: DEPLOYMENT_ID,
      endpointUrl: ENDPOINT,
    });
    const json = JSON.stringify(card);
    const parsed = JSON.parse(json);
    expect(McpServerCardSchema.parse(parsed).transport.tools_list).toBe(
      `${ENDPOINT}/mcp/tools`,
    );
  });

  it('should produce Claude config user can paste into claude_desktop_config.json', () => {
    const card = generateMcpServerCard({ deploymentId: DEPLOYMENT_ID, endpointUrl: ENDPOINT });
    const configJson = serializeClaudeDesktopConfig(
      ClaudeDesktopConfigSchema.parse({
        mcpServers: {
          'echo-agent': { url: card.transport.tools_list },
        },
      }),
    );
    expect(() => JSON.parse(configJson)).not.toThrow();
    expect(configJson).toContain('/mcp/tools');
  });
});
