#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  ElevenLabsApiError,
  ElevenLabsAuthError,
  ElevenLabsConfigError,
  ElevenLabsFileError,
  ElevenLabsIpBlockedError,
  ElevenLabsNetworkError,
  ElevenLabsQuotaError,
  ElevenLabsRateLimitError,
  ElevenLabsScopeError,
  ElevenLabsTimeoutError,
} from './errors.js';
import { ElevenLabsClient, isBinaryResult, type BinaryResult } from './api.js';
import { VERSION } from './version.js';
import { generatedTools, type GeneratedTool } from './tools/generated.js';

const SERVER_NAME = '@aiwerk/mcp-server-elevenlabs';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'audio'; data: string; mimeType: string };

function toolSuccess(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * A binary payload comes back one of two ways, and the agent needs to be told which.
 *
 * Written to disk: a text block with the path, because a file path is what the next
 * step in a pipeline actually consumes. Returned inline: an MCP audio block, so a
 * client that can play or forward audio does not have to guess that a base64 string
 * was audio. The summary line accompanies both — without it, an audio-only result
 * gives a text-only client nothing at all to work with.
 */
export function binaryContent(result: BinaryResult): { content: ContentBlock[] } {
  const summary: Record<string, unknown> = {
    contentType: result.contentType,
    bytes: result.bytes,
  };
  if (result.path) summary.path = result.path;
  if (result.requestId) summary.requestId = result.requestId;
  if (result.characterCost) summary.characterCost = result.characterCost;
  if (!result.path && result.base64) summary.delivery = 'inline base64 in the audio block';

  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
  if (!result.path && result.base64) {
    content.push({ type: 'audio', data: result.base64, mimeType: result.contentType });
  }
  return { content };
}

export function toolError(error: unknown) {
  let message: string;
  if (error instanceof ElevenLabsTimeoutError) {
    message = `Timeout: ${error.message}. Generation calls can be slow — raise ELEVENLABS_API_TIMEOUT_MS or retry.`;
  } else if (error instanceof ElevenLabsNetworkError) {
    message = `Network error: ${error.message}. Check connectivity.`;
  } else if (error instanceof ElevenLabsConfigError) {
    message = `Configuration error: ${error.message}`;
  } else if (error instanceof ElevenLabsFileError) {
    message = `File error: ${error.message}`;
  } else if (
    error instanceof ElevenLabsQuotaError ||
    error instanceof ElevenLabsScopeError ||
    error instanceof ElevenLabsIpBlockedError ||
    error instanceof ElevenLabsRateLimitError ||
    error instanceof ElevenLabsAuthError
  ) {
    message = error.message; // already carries the recovery hint
  } else if (error instanceof ElevenLabsApiError) {
    const body = error.body == null ? '' : ` — body: ${JSON.stringify(error.body)}`;
    message = `${error.message}${body}`;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function toTitleCase(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Optional narrowing via ELEVENLABS_ENABLED_DOMAINS (comma-separated, case-insensitive).
 *
 * Everything is on by default. 390 tools is a lot for a client wired straight to the
 * server rather than through the AIWerk hosted bridge's Smart Router, so an install
 * that only wants text-to-speech can say so. Unknown names are reported rather than
 * ignored: a typo would otherwise look like a working filter that hides most of the API.
 */
export function selectTools(
  tools: GeneratedTool[],
  rawFilter: string | undefined,
): { selected: GeneratedTool[]; unknown: string[] } {
  if (!rawFilter || rawFilter.trim() === '') return { selected: tools, unknown: [] };

  const wanted = new Set(
    rawFilter
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const known = new Set(tools.map((t) => t.domain.toLowerCase()));
  const unknown = [...wanted].filter((w) => !known.has(w));
  const selected = tools.filter((t) => wanted.has(t.domain.toLowerCase()));
  return { selected, unknown };
}

/** ELEVENLABS_HIDE_DEPRECATED=1 drops the 21 operations upstream has marked deprecated. */
export function applyDeprecationFilter(tools: GeneratedTool[], hide: boolean): GeneratedTool[] {
  return hide ? tools.filter((t) => !t.deprecated) : tools;
}

export function createServer() {
  const client = new ElevenLabsClient();
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  const pool = applyDeprecationFilter(generatedTools, process.env.ELEVENLABS_HIDE_DEPRECATED === '1');
  const { selected, unknown } = selectTools(pool, process.env.ELEVENLABS_ENABLED_DOMAINS);
  if (unknown.length > 0) {
    console.error(
      `[mcp-server-elevenlabs] WARNING: ELEVENLABS_ENABLED_DOMAINS names unknown domains: ${unknown.join(', ')}`,
    );
  }
  // A typo'd filter that matches nothing would otherwise start a server advertising
  // zero tools with only a stderr warning most MCP clients never surface —
  // indistinguishable from a deliberately narrow filter. Fail loudly instead.
  if (selected.length === 0) {
    const valid = [...new Set(pool.map((t) => t.domain))].sort().join(', ');
    throw new ElevenLabsConfigError(
      `ELEVENLABS_ENABLED_DOMAINS="${process.env.ELEVENLABS_ENABLED_DOMAINS}" matched zero tools` +
        (unknown.length > 0 ? ` (unknown: ${unknown.join(', ')})` : '') +
        `. Valid domains: ${valid}`,
    );
  }

  for (const tool of selected) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // registerTool wants a ZodRawShape. Only newer SDK releases normalize a full
        // ZodObject themselves; on the ^1.19.1 floor in package.json, passing the
        // object directly crashes every tools/list call with "Cannot read properties
        // of null (reading '_def')". .shape works across the whole 1.x range.
        inputSchema: (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape,
        annotations: {
          title: toTitleCase(tool.name),
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(client, args as never);
          return isBinaryResult(result) ? binaryContent(result) : toolSuccess(result);
        } catch (err) {
          return toolError(err);
        }
      },
    );
  }

  return { server, toolCount: selected.length };
}

/**
 * Logging from a crash handler can itself crash. Once the client goes away the pipe
 * is gone, so console.error throws EPIPE, which re-enters the handler and spins the
 * process at 100% CPU as an orphan. It is an easy loop to reintroduce, so the EPIPE
 * path exits instead of reporting.
 */
function installCrashHandlers(shutdown: (reason: string) => void): void {
  const isBrokenPipe = (err: unknown): boolean =>
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EPIPE';

  const report = (label: string, err: unknown): void => {
    if (isBrokenPipe(err)) {
      shutdown('EPIPE (client went away)');
      return;
    }
    try {
      console.error(
        `[mcp-server-elevenlabs] ${label}:`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    } catch {
      shutdown('stderr unavailable');
    }
  };

  process.on('uncaughtException', (err) => report('uncaughtException', err));
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));
  process.stdout.on('error', (err) => {
    if (isBrokenPipe(err)) shutdown('stdout EPIPE');
  });
  process.stderr.on('error', () => {
    /* nothing can be logged about a dead stderr */
  });
}

export async function main(): Promise<void> {
  const { server, toolCount } = createServer();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  installCrashHandlers(shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[mcp-server-elevenlabs] v${VERSION} ready with ${toolCount} tools`);
  if (process.env.ELEVENLABS_DRY_RUN === '1') {
    console.error('[mcp-server-elevenlabs] ELEVENLABS_DRY_RUN=1 — no request leaves this process');
  }
  if (!process.env.ELEVENLABS_OUTPUT_DIR) {
    console.error(
      '[mcp-server-elevenlabs] ELEVENLABS_OUTPUT_DIR is unset — generated audio comes back inline as base64 (small files only)',
    );
  }

  // The client owns our lifecycle in stdio mode; when it closes our stdin we go.
  process.stdin.on('end', () => shutdown());
  process.stdin.on('close', () => shutdown());
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.stdin.resume();
}

// Only auto-start when executed directly, so tests can import createServer().
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('[mcp-server-elevenlabs] fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
