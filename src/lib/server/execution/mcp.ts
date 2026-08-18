import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CatalogResource, JsonSchema } from '$lib/types/catalog';
import { assertSafeExternalUrl, safeMcpFetch } from '$lib/server/security/egress';
import { chooseMcpTool, compileArguments, validateArguments } from '$lib/server/openrouter';
import { assertLeanV0Feature } from '$lib/server/network/policy';

type Tool = { name: string; description?: string; inputSchema?: JsonSchema };

async function connect(endpoint: URL) {
  const modern = new Client({ name: 'algoria-agent-runner', version: '0.1.0' });
  try {
    await modern.connect(new StreamableHTTPClientTransport(endpoint, { fetch: safeMcpFetch }), { timeout: 15_000 });
    return modern;
  } catch {
    await modern.close().catch(() => undefined);
    const legacy = new Client({ name: 'algoria-agent-runner', version: '0.1.0' });
    await legacy.connect(new SSEClientTransport(endpoint, { fetch: safeMcpFetch }), { timeout: 15_000 });
    return legacy;
  }
}

async function listedTools(client: Client): Promise<Tool[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as JsonSchema
  })) as Tool[];
}

export async function prepareMcp(resource: CatalogResource, prompt: string) {
  assertLeanV0Feature('mcpExecution');
  const endpoint = await assertSafeExternalUrl(resource.endpoint);
  const client = await connect(endpoint);
  try {
    const tools = await listedTools(client);
    const selected = await chooseMcpTool(prompt, tools);
    const args = await compileArguments(prompt, selected.inputSchema);
    return { tool: selected.name, arguments: args };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function executeMcp(resource: CatalogResource, prepared: { tool: string; arguments: Record<string, unknown> }) {
  assertLeanV0Feature('mcpExecution');
  const endpoint = await assertSafeExternalUrl(resource.endpoint);
  const client = await connect(endpoint);
  try {
    const tools = await listedTools(client);
    const tool = tools.find((candidate) => candidate.name === prepared.tool);
    if (!tool) throw new Error('The reviewed MCP tool is no longer available');
    const args = validateArguments(prepared.arguments, tool.inputSchema ?? { type: 'object', properties: {} });
    const result = await client.callTool({ name: tool.name, arguments: args }, { timeout: 60_000 });
    if (result.isError) throw new Error('The MCP tool reported an execution error');
    return {
      tool: tool.name,
      arguments: args,
      output: result.structuredContent ?? result.content
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
