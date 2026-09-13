/** Public types for script authors: `import type { Ctx } from "dcompose"`. */
export type { Ctx, Mcp, McpServers, McpProxy, ServerProxy, ToolFn, StdinHelper } from "./runtime/context.ts";
export type { PmapOptions } from "./runtime/pmap.ts";
export type { Store } from "./runtime/store.ts";
export type { PageResult, PaginateOptions } from "./runtime/context.ts";
export { unwrap } from "./runtime/context.ts";
export { NeedsAuthError } from "./auth/provider.ts";
export type { ShOptions, ShResult } from "./runtime/sh.ts";
export type { CallRecord, RunHeader, RunSummary } from "./runtime/trace.ts";
export type { CallToolResult as RawToolResult } from "@modelcontextprotocol/sdk/types.js";
export { GuardrailError } from "./runtime/context.ts";
export { ToolError } from "./result.ts";
