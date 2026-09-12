// Minimal stdio MCP server used by the integration tests. No network, no credentials.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.1" });

server.registerTool(
  "echo",
  {
    description: "Return the arguments as structuredContent.",
    inputSchema: z.object({ value: z.any().optional(), text: z.string().optional() }),
    annotations: { readOnlyHint: true },
  },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: args }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers; returns JSON text only (no structuredContent).",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: JSON.stringify({ sum: a + b }) }] }),
);

server.registerTool(
  "list",
  {
    description: "Return n items so scripts can fan out.",
    inputSchema: z.object({ n: z.number().int().min(0).max(1000) }),
    annotations: { readOnlyHint: true },
  },
  async ({ n }) => {
    const items = Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, active: i % 2 === 0 }));
    return { content: [{ type: "text", text: JSON.stringify(items) }] };
  },
);

server.registerTool(
  "prose",
  {
    description: "Return plain text that is not JSON.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: "text", text: "just some words" }] }),
);

server.registerTool(
  "fail",
  { description: "Always returns an MCP tool error.", inputSchema: z.object({ message: z.string().optional() }) },
  async ({ message }) => ({ content: [{ type: "text", text: message ?? "it failed" }], isError: true }),
);

server.registerTool(
  "write_thing",
  { description: "A tool with no readOnlyHint, for --read-only tests.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: JSON.stringify({ wrote: true }) }] }),
);

server.registerTool(
  "slow",
  {
    description: "Sleep for ms then return.",
    inputSchema: z.object({ ms: z.number() }),
    annotations: { readOnlyHint: true },
  },
  async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { content: [{ type: "text", text: JSON.stringify({ slept: ms }) }] };
  },
);

await server.connect(new StdioServerTransport());
