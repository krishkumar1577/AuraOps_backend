import { z } from 'zod';

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});

export const McpServerCardSchema = z.object({
  schema_version: z.literal('1.0'),
  name: z.string(),
  deployment_id: z.string(),
  description: z.string(),
  transport: z.object({
    type: z.literal('http'),
    base_url: z.string().url(),
    health: z.string().url(),
    tools_list: z.string().url(),
    tools_call: z.string().url(),
  }),
  tools: z.array(McpToolSchema),
});

export type McpServerCard = z.infer<typeof McpServerCardSchema>;

export const ClaudeDesktopConfigSchema = z.object({
  mcpServers: z.record(
    z.object({
      url: z.string().url(),
    }),
  ),
});

export type ClaudeDesktopConfig = z.infer<typeof ClaudeDesktopConfigSchema>;

export interface McpCardOptions {
  deploymentId: string;
  endpointUrl: string;
  agentName?: string;
  toolName?: string;
}

/**
 * Derive MCP route URLs from the live agent endpoint (same Modal host).
 */
export function buildMcpUrls(endpointUrl: string): {
  baseUrl: string;
  health: string;
  toolsList: string;
  toolsCall: string;
} {
  const baseUrl = endpointUrl.replace(/\/$/, '');
  return {
    baseUrl,
    health: `${baseUrl}/mcp/health`,
    toolsList: `${baseUrl}/mcp/tools`,
    toolsCall: `${baseUrl}/mcp/tools/call`,
  };
}

/**
 * Generate discoverable MCP server card (valid JSON for clients and Claude Desktop).
 */
export function generateMcpServerCard(options: McpCardOptions): McpServerCard {
  const { deploymentId, endpointUrl, agentName, toolName = 'invoke_agent' } = options;
  const urls = buildMcpUrls(endpointUrl);
  const name = agentName ?? `auraops-${deploymentId.slice(0, 8)}`;

  const card: McpServerCard = {
    schema_version: '1.0',
    name,
    deployment_id: deploymentId,
    description: `AuraOps deployed agent (${deploymentId}) exposed as MCP tools`,
    transport: {
      type: 'http',
      base_url: urls.baseUrl,
      health: urls.health,
      tools_list: urls.toolsList,
      tools_call: urls.toolsCall,
    },
    tools: [
      {
        name: toolName,
        description: 'Invoke the deployed AuraOps agent with a text prompt',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Prompt or message for the agent' },
            metadata: { type: 'object', description: 'Optional metadata' },
          },
          required: ['input'],
        },
      },
    ],
  };

  return McpServerCardSchema.parse(card);
}

/**
 * Claude Desktop claude_desktop_config.json snippet (copy-paste ready).
 * Uses HTTP URL transport supported by Claude Desktop MCP clients.
 */
export function generateClaudeDesktopConfig(options: McpCardOptions): ClaudeDesktopConfig {
  const card = generateMcpServerCard(options);
  const serverKey = card.name.replace(/[^a-zA-Z0-9_-]/g, '-');

  const config: ClaudeDesktopConfig = {
    mcpServers: {
      [serverKey]: {
        url: card.transport.tools_list,
      },
    },
  };

  return ClaudeDesktopConfigSchema.parse(config);
}

/**
 * Serialize card to JSON string (validated round-trip).
 */
export function serializeMcpCard(card: McpServerCard): string {
  const json = JSON.stringify(card, null, 2);
  McpServerCardSchema.parse(JSON.parse(json));
  return json;
}

export function serializeClaudeDesktopConfig(config: ClaudeDesktopConfig): string {
  const json = JSON.stringify(config, null, 2);
  ClaudeDesktopConfigSchema.parse(JSON.parse(json));
  return json;
}
