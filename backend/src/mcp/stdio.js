import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOdinApiClient } from './api-client.js';
import { createOdinMcpServer } from './server.js';

try {
  const api = createOdinApiClient({ baseUrl: process.env.ODIN_MCP_BASE_URL, token: process.env.ODIN_MCP_ACCESS_TOKEN });
  const server = createOdinMcpServer({ api });
  await server.connect(new StdioServerTransport());
  const close = async () => { await server.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  // stdout is reserved for MCP. Never log env values or a credential-bearing stack.
  process.stderr.write('Odin MCP could not start. Check ODIN_MCP_BASE_URL, ODIN_MCP_ACCESS_TOKEN, and installed dependencies.\n');
  process.exitCode = 1;
}
