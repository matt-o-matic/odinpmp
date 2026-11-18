import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';
import { splitMedia } from '../lib/agent/agent-media.js';
import { OdinApiError } from './api-client.js';
import { createOdinToolCatalog, ODIN_TOOL_INSTRUCTIONS } from './catalog.js';
import { withChangeScope } from './change-scope.js';

// Every request to /mcp gets its own server, but the tools, their Zod schemas and their JSON
// Schemas are the same for all of them. Building those was most of what a request cost: about
// 5 MB of allocation each, so a burst of a few hundred requests drove the backend past PM2's
// memory limit (measured 2026-10-30). They are built once. Tool handlers reach the current
// request's API client through `requestApi`, so each call still runs with its own credentials and
// change scope.
const requestApi = new AsyncLocalStorage();
const routedApi = {
  checkItemLimit: (...args) => requestApi.getStore().checkItemLimit?.(...args),
  request: (...args) => requestApi.getStore().request(...args),
};
let sharedTools = null;
function sharedCatalog() {
  sharedTools ??= createOdinToolCatalog({ api: routedApi }).map((entry) => ({
    ...entry,
    jsonSchema: toJsonSchemaCompat(entry.schema, { strictUnions: true, pipeStrategy: 'input' }),
  }));
  return sharedTools;
}

// One media entry as MCP content: an image, or a PDF as an embedded resource.
export function mcpMediaContent({ contentType, data, kind, name }) {
  if (kind === 'pdf') return { type: 'resource', resource: { blob: data, mimeType: 'application/pdf', uri: `odin-file:///${encodeURIComponent(name || 'document.pdf')}` } };
  return { data, mimeType: contentType, type: 'image' };
}

export function createOdinMcpServer({ api: client, authorizeTool = () => {}, oauth = false }) {
  // Each tool call is counted on its own (change-scope.js).
  const api = withChangeScope(client);
  const handlers = new Map();
  const catalog = [];
  const server = new McpServer({ name: 'odin-v2', version: '0.1.0' }, {
    instructions: ODIN_TOOL_INSTRUCTIONS,
  });
  for (const { name, description, schema, handler, write, destructive, jsonSchema } of sharedCatalog()) {
    const call = async (args) => {
      try {
        const parsed = schema.parse(args);
        await authorizeTool({ name, write });
        api.reset();
        const result = await requestApi.run(api, () => handler(parsed));
        // Media (odin_view_project_file) goes as image or embedded-resource content, not JSON.
        const { media, result: rest } = splitMedia(result);
        return { content: [{ type: 'text', text: JSON.stringify(rest) }, ...media.map(mcpMediaContent)], structuredContent: rest };
      } catch (error) {
        const result = error instanceof OdinApiError
          ? { ok: false, error: { code: error.code, status: error.status, message: error.message, outcomeUnknown: error.outcomeUnknown, ...(error.details === undefined ? {} : { details: error.details }) } }
          : error instanceof z.ZodError
            ? { ok: false, error: { code: 'validation_error', message: 'Invalid tool arguments.' } }
            : { ok: false, error: { code: 'internal_error', message: 'The Odin MCP operation could not complete.' } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    };
    handlers.set(name, call);
    const securitySchemes = [{ type: 'oauth2', scopes: write ? ['projects.read', 'projects.write'] : ['projects.read'] }];
    const definition = {
      description, inputSchema: schema,
      annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write, openWorldHint: true },
      ...(oauth ? { _meta: { securitySchemes } } : {}),
    };
    catalog.push({ name, ...definition, inputSchema: jsonSchema, ...(oauth ? { securitySchemes } : {}) });
    server.registerTool(name, definition, call);
  }
  // The SDK's default validation errors echo input values. Validate in our redacted handler instead.
  if (oauth) server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const handler = handlers.get(params.name);
    if (!handler || params.task) {
      const result = { ok: false, error: { code: 'invalid_tool_call', message: 'Unknown tool or unsupported task execution.' } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
    return handler(params.arguments ?? {});
  });
  return server;
}
