import {
  generateMcpServerWrapper,
  generateMcpFastApiRouteStub,
  generateMcpUnifiedAsgiStub,
} from '../mcpEndpointGenerator';

describe('mcpEndpointGenerator', () => {
  const deploymentId = 'dep_mcp_test123';

  describe('generateMcpServerWrapper', () => {
    it('should generate stdio MCP server wrapper with deployment id', () => {
      const code = generateMcpServerWrapper({ deploymentId });

      expect(code).toContain('stdio_server');
      expect(code).toContain(`Server("auraops-${deploymentId}")`);
      expect(code).toContain('invoke_agent');
      expect(code).toContain('list_tools');
      expect(code).toContain('call_tool');
    });

    it('should support custom tool name', () => {
      const code = generateMcpServerWrapper({ deploymentId, toolName: 'run_inference' });

      expect(code).toContain('run_inference');
      expect(code).not.toContain('invoke_agent');
    });
  });

  describe('generateMcpUnifiedAsgiStub', () => {
    it('should generate single-URL ASGI with MCP routes', () => {
      const code = generateMcpUnifiedAsgiStub({ deploymentId });

      expect(code).toContain('@modal.asgi_app()');
      expect(code).toContain('/mcp/tools');
      expect(code).toContain('agent_instance.endpoint');
    });
  });

  describe('generateMcpFastApiRouteStub', () => {
    it('should generate FastAPI route stub with lazy imports', () => {
      const code = generateMcpFastApiRouteStub({ deploymentId });

      expect(code).toContain('def _build_mcp_app():');
      expect(code).toContain('from fastapi import FastAPI');
      expect(code).toContain('/mcp/tools');
      expect(code).toContain('/mcp/tools/call');
      expect(code).toContain(`"deployment_id": "${deploymentId}"`);
      expect(code).toContain('@modal.asgi_app()');
    });
  });
});
