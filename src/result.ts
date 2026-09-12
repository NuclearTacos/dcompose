import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class ToolError extends Error {
  readonly server: string;
  readonly tool: string;
  readonly result: CallToolResult;
  constructor(server: string, tool: string, result: CallToolResult) {
    super(`${server}.${tool} returned an error: ${textOf(result)}`);
    this.name = "ToolError";
    this.server = server;
    this.tool = tool;
    this.result = result;
  }
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n")
    .slice(0, 2000);
}

/**
 * Turn an MCP CallToolResult into a plain value a script can work with.
 *
 *  - `structuredContent` wins when present.
 *  - text blocks that parse as JSON become values; other text stays a string.
 *  - image/audio blocks become `{ type, mimeType, bytes }` (data dropped; use raw to get it).
 *  - resource blocks pass through as-is.
 *  - 0 blocks → null, 1 block → the value, N blocks → array.
 */
export function parseResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;

  const blocks = (result.content ?? []).map((c) => {
    switch (c.type) {
      case "text":
        return tryJson(c.text);
      case "image":
      case "audio":
        return { type: c.type, mimeType: c.mimeType, bytes: Math.floor((c.data.length * 3) / 4) };
      case "resource":
        return c.resource;
      case "resource_link":
        return c;
      default:
        return c;
    }
  });

  if (blocks.length === 0) return null;
  if (blocks.length === 1) return blocks[0];
  return blocks;
}

export function tryJson(text: string): unknown {
  const t = text.trim();
  if (t === "") return text;
  const first = t[0];
  // Cheap gate before paying for JSON.parse on prose.
  if (
    first !== "{" &&
    first !== "[" &&
    first !== '"' &&
    !/^-?\d/.test(t) &&
    t !== "true" &&
    t !== "false" &&
    t !== "null"
  ) {
    return text;
  }
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}
