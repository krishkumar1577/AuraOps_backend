import {
  buildMcpUrls,
  generateClaudeDesktopConfig,
  generateMcpServerCard,
  serializeClaudeDesktopConfig,
  serializeMcpCard,
  McpServerCardSchema,
  ClaudeDesktopConfigSchema,
} from '../mcpCardGenerator';

const ENDPOINT = 'https://workspace--auraops-dep-abc123.modal.run';
const DEPLOYMENT_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('mcpCardGenerator', () => {
  it('should produce valid JSON MCP card with correct URLs', () => {
    const card = generateMcpServerCard({
      deploymentId: DEPLOYMENT_ID,
      endpointUrl: ENDPOINT,
    });

    const json = serializeMcpCard(card);
    const parsed = JSON.parse(json);

    expect(() => McpServerCardSchema.parse(parsed)).not.toThrow();
    expect(parsed.transport.base_url).toBe(ENDPOINT);
    expect(parsed.transport.health).toBe(`${ENDPOINT}/mcp/health`);
    expect(parsed.transport.tools_list).toBe(`${ENDPOINT}/mcp/tools`);
    expect(parsed.transport.tools_call).toBe(`${ENDPOINT}/mcp/tools/call`);
    expect(parsed.deployment_id).toBe(DEPLOYMENT_ID);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe('invoke_agent');
  });

  it('should produce copy-paste Claude Desktop config with correct URL', () => {
    const config = generateClaudeDesktopConfig({
      deploymentId: DEPLOYMENT_ID,
      endpointUrl: ENDPOINT,
      agentName: 'echo-agent',
    });

    const json = serializeClaudeDesktopConfig(config);
    const parsed = JSON.parse(json);

    expect(() => ClaudeDesktopConfigSchema.parse(parsed)).not.toThrow();
    const serverKey = Object.keys(parsed.mcpServers)[0];
    expect(parsed.mcpServers[serverKey].url).toBe(`${ENDPOINT}/mcp/tools`);
    expect(json).toContain('mcpServers');
    expect(json).toContain('/mcp/tools');
  });

  it('should strip trailing slash from endpoint when building URLs', () => {
    const urls = buildMcpUrls(`${ENDPOINT}/`);
    expect(urls.health).toBe(`${ENDPOINT}/mcp/health`);
    expect(urls.toolsList).toBe(`${ENDPOINT}/mcp/tools`);
  });
});
