// Shared harness for the smoke scripts: spawn the built server, speak MCP to it
// over stdio, and read the API token from pass without ever printing it.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '../..');

/** Read the ElevenLabs API key from the password store. Never logged. */
export function readToken(passEntry = 'api/elevenlabs') {
  try {
    return execFileSync('pass', ['show', passEntry], { encoding: 'utf-8' }).split('\n')[0].trim();
  } catch {
    console.error(`Could not read the API key from pass entry "${passEntry}".`);
    console.error(`Store it first:  pass insert ${passEntry}`);
    process.exit(1);
  }
}

export function startServer(token, extraEnv = {}) {
  const child = spawn(process.execPath, [join(repoRoot, 'dist/src/server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELEVENLABS_API_KEY: token, ...extraEnv },
  });
  child.stderr.on('data', (buf) => {
    const line = String(buf).trim();
    if (line) console.error(`  [server] ${line}`);
  });
  return child;
}

export function rpcChannel(child) {
  const pending = new Map();
  let nextId = 1;

  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 30_000);
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  return { call, notify };
}

export async function connect(child) {
  const { call, notify } = rpcChannel(child);
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'elevenlabs-smoke', version: '1.0.0' },
  });
  notify('notifications/initialized', {});
  return { call, notify, init };
}

/**
 * Call a tool and unwrap the payload. Tool-level failures arrive as a normal
 * result with isError set, not as a protocol error, so both paths are folded
 * into one shape here.
 */
export async function callTool(call, name, args) {
  const result = await call('tools/call', { name, arguments: args });
  const text = result?.content?.[0]?.text ?? '';
  if (result?.isError) {
    return { ok: false, error: text.split('\n')[0].slice(0, 200), raw: text };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
}
