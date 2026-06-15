export interface McpEndpointOptions {
  deploymentId: string;
  toolName?: string;
}

/**
 * Generates a Python MCP server wrapper using stdio transport.
 * Exposes the deployed agent as callable MCP tools.
 */
export function generateMcpServerWrapper(options: McpEndpointOptions): string {
  const { deploymentId, toolName = 'invoke_agent' } = options;

  return `#!/usr/bin/env python3
"""
AuraOps MCP Server Wrapper
Deployment ID: ${deploymentId}
Transport: stdio (Model Context Protocol)
"""

import asyncio
import json
import sys


async def _run_stdio_server() -> None:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import Tool, TextContent

    server = Server("auraops-${deploymentId}")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="${toolName}",
                description="Invoke the AuraOps deployed agent",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "input": {"type": "string", "description": "Prompt or input for the agent"},
                        "metadata": {"type": "object", "description": "Optional metadata"},
                    },
                    "required": ["input"],
                },
            )
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        if name != "${toolName}":
            raise ValueError(f"Unknown tool: {name}")

        # Agent invocation is wired at deploy time via HTTP endpoint bridge
        input_text = arguments.get("input", "")
        metadata = arguments.get("metadata", {})
        result = {
            "output": f"[MCP stub] Received input: {input_text}",
            "deployment_id": "${deploymentId}",
            "metadata": metadata,
        }
        return [TextContent(type="text", text=json.dumps(result))]

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> None:
    asyncio.run(_run_stdio_server())


if __name__ == "__main__":
    main()
`;
}

/**
 * Generates unified FastAPI ASGI app with inference + MCP routes on one endpoint.
 * Used when enableMcp=true so Claude Desktop hits the same Modal URL.
 */
export function generateMcpUnifiedAsgiStub(options: McpEndpointOptions): string {
  const { deploymentId, toolName = 'invoke_agent' } = options;

  return `
    @modal.asgi_app()
    def asgi(self):
        """Unified inference + MCP HTTP app (single Modal URL)."""
        import json
        from fastapi import FastAPI
        from pydantic import BaseModel

        web = FastAPI(title="AuraOps Agent + MCP")

        class InferenceRequest(BaseModel):
            input: str = ""
            metadata: dict = {}

        class ToolCallRequest(BaseModel):
            name: str
            arguments: dict

        agent_instance = self

        @web.post("/")
        def inference(request: InferenceRequest):
            return agent_instance.endpoint(request.model_dump())

        @web.get("/mcp/health")
        def mcp_health():
            return {"status": "ready", "deployment_id": "${deploymentId}"}

        @web.get("/mcp/tools")
        def mcp_list_tools():
            return {
                "tools": [
                    {
                        "name": "${toolName}",
                        "description": "Invoke the AuraOps deployed agent",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "string"},
                                "metadata": {"type": "object"},
                            },
                            "required": ["input"],
                        },
                    }
                ]
            }

        @web.post("/mcp/tools/call")
        def mcp_call_tool(request: ToolCallRequest):
            if request.name != "${toolName}":
                return {"error": f"Unknown tool: {request.name}"}
            result = agent_instance.endpoint({
                "input": request.arguments.get("input", ""),
                "metadata": request.arguments.get("metadata", {}),
            })
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result),
                    }
                ]
            }

        return web
`;
}

/**
 * Generates a FastAPI route stub appended to Modal apps when MCP is enabled (legacy separate ASGI).
 * @deprecated Use generateMcpUnifiedAsgiStub for single-URL MCP
 */
export function generateMcpFastApiRouteStub(options: McpEndpointOptions): string {
  const { deploymentId, toolName = 'invoke_agent' } = options;

  return `

# --- AuraOps MCP Integration (lazy imports) ---
@app.function(image=image)
@modal.asgi_app()
def mcp_asgi():
    """MCP tool bridge — exposes agent as MCP-compatible HTTP routes."""

    def _build_mcp_app():
        from fastapi import FastAPI
        from pydantic import BaseModel

        mcp_app = FastAPI(title="AuraOps MCP Bridge")

        class ToolCallRequest(BaseModel):
            name: str
            arguments: dict

        @mcp_app.get("/mcp/health")
        def mcp_health():
            return {"status": "ready", "deployment_id": "${deploymentId}"}

        @mcp_app.get("/mcp/tools")
        def mcp_list_tools():
            return {
                "tools": [
                    {
                        "name": "${toolName}",
                        "description": "Invoke the AuraOps deployed agent",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "string"},
                                "metadata": {"type": "object"},
                            },
                            "required": ["input"],
                        },
                    }
                ]
            }

        @mcp_app.post("/mcp/tools/call")
        def mcp_call_tool(request: ToolCallRequest):
            if request.name != "${toolName}":
                return {"error": f"Unknown tool: {request.name}"}
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {
                                "output": request.arguments.get("input", ""),
                                "deployment_id": "${deploymentId}",
                            }
                        ),
                    }
                ]
            }

        return mcp_app

    import json
    return _build_mcp_app()
`;
}
