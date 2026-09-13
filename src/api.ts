// ElevenLabs API client — xi-api-key auth, multipart uploads, binary downloads.
//
// AUTH: a single `xi-api-key` header, documented as the only scheme for the REST
// API. The OpenAPI document declares no securityScheme at all (components.
// securitySchemes is empty, every operation carries security: null), so the header
// cannot be derived from the spec and is set here instead. The hosted MCP server
// ElevenLabs runs takes OAuth rather than a key, but that endpoint is a different
// product with seven scopes; nothing in the REST surface accepts a bearer token.
//
// KEY SCOPE: an ElevenLabs key can be restricted per endpoint group, given its own
// credit quota, and locked to an IP range. All three failures come back as 401 with
// different bodies, and "check your credentials" is the wrong advice for each of
// them — hence the three error subclasses below.
//
// MULTIPART: 31 operations take files. Each binary field is exposed to the agent
// twice, as `<field>_path` (a local file) and `<field>_base64` (inline bytes),
// because the two deployments differ: a locally installed server can read the
// user's disk, one running in the hosted bridge's container cannot see it at all.
//
// BINARY RESPONSES: 21 operations return audio, video or zip. Reading those as JSON
// produces a mojibake string that looks like a successful call, so they are written
// to disk when there is somewhere to write, and returned as an inline MCP audio
// block only when they are small enough to be worth the base64 inflation.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

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

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

/** Max 429 retries before giving up and surfacing the error to the agent. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** How long we are willing to sleep for a rate-limit reset before failing instead. */
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 10_000;

/**
 * Below this, a binary response can come back inline as base64. Above it the agent
 * gets a file path or an error asking for one. Base64 inflates by a third and every
 * byte crosses the model's context, so a three-minute MP3 inline is a bad default.
 */
const DEFAULT_MAX_INLINE_BYTES = 4 * 1024 * 1024;

export type Query = Record<string, string | number | boolean | null | string[]>;

export interface BinaryResult {
  /** Marker the server layer looks for; never sent to the API. */
  __binary: true;
  contentType: string;
  bytes: number;
  /** Set when the payload was written to disk. */
  path?: string;
  /** Set when the payload is small enough to travel inline. */
  base64?: string;
  requestId?: string;
  characterCost?: string;
}

export function isBinaryResult(value: unknown): value is BinaryResult {
  return typeof value === 'object' && value !== null && (value as BinaryResult).__binary === true;
}

/** One multipart field as the generated tool describes it. */
export interface FilePart {
  field: string;
  path?: string;
  base64?: string;
  filename?: string;
}

export interface RequestOptions {
  method: string;
  path: string;
  query?: Query;
  /** JSON body. Mutually exclusive with form. */
  body?: unknown;
  /** multipart/form-data scalar fields. */
  form?: Record<string, unknown>;
  /** multipart/form-data file fields. */
  files?: FilePart[];
  /** The operation returns bytes, not JSON. */
  binary?: { primary: string };
  /** Where the caller wants the bytes written, if anywhere. */
  outputPath?: string;
  /** True for GET; lets dry-run block writes without blocking reads. */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Config (read at call time, not module load, so tests can override)
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const v = process.env.ELEVENLABS_API_KEY;
  if (!v) {
    throw new ElevenLabsConfigError(
      'ELEVENLABS_API_KEY is required. Create one at https://elevenlabs.io/app/settings/api-keys.',
    );
  }
  return v;
}

function getBaseUrl(): string {
  return (process.env.ELEVENLABS_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function positiveInt(raw: string | undefined, fallback: number, name: string, allowZero = false): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
    throw new ElevenLabsConfigError(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer (got "${raw}")`,
    );
  }
  return n;
}

function getTimeoutMs(): number {
  // Generation is slow: a long dubbing or music call routinely outlives the 30s
  // that suits a CRUD API, and a timeout there still bills the credits.
  return positiveInt(process.env.ELEVENLABS_API_TIMEOUT_MS, 120_000, 'ELEVENLABS_API_TIMEOUT_MS');
}

function getMaxRateLimitWaitMs(): number {
  return positiveInt(
    process.env.ELEVENLABS_MAX_RATE_LIMIT_WAIT_MS,
    DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
    'ELEVENLABS_MAX_RATE_LIMIT_WAIT_MS',
    true,
  );
}

function getMaxInlineBytes(): number {
  return positiveInt(
    process.env.ELEVENLABS_MAX_INLINE_BYTES,
    DEFAULT_MAX_INLINE_BYTES,
    'ELEVENLABS_MAX_INLINE_BYTES',
    true,
  );
}

function getOutputDir(): string | null {
  const v = process.env.ELEVENLABS_OUTPUT_DIR;
  return v && v.trim() !== '' ? resolve(v) : null;
}

function isDryRun(): boolean {
  return process.env.ELEVENLABS_DRY_RUN === '1';
}

/** Cap on a file read into memory for upload. Guards against handing fetch a 2 GB Buffer. */
function getMaxUploadBytes(): number {
  return positiveInt(process.env.ELEVENLABS_MAX_UPLOAD_BYTES, 512 * 1024 * 1024, 'ELEVENLABS_MAX_UPLOAD_BYTES');
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/** Strip anything key-shaped out of error bodies before they reach the agent. */
export function redactSecrets(body: unknown): unknown {
  if (typeof body === 'string') {
    return body
      .replace(/(xi-api-key\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
      .replace(/\bsk_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
      // Only a name FOLLOWED BY A VALUE is a leak. Matching the bare word instead
      // rewrote ElevenLabs' own error codes — "missing_api_key" became
      // "missing_api_key=[REDACTED]" — and the classifier below then read the
      // mangled string and reported a permissions problem for an absent key.
      .replace(
        /\b(access_token|refresh_token|client_secret|api[-_]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{6,}["']?/gi,
        '$1=[REDACTED]',
      );
  }
  if (Array.isArray(body)) return body.map(redactSecrets);
  if (typeof body === 'object' && body !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = /api[-_]?key|authorization|access_token|refresh_token|client_secret/i.test(k)
        ? '[REDACTED]'
        : redactSecrets(v);
    }
    return out;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const EXT_BY_TYPE: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/pcm': '.pcm',
  'audio/basic': '.ulaw',
  'video/mp4': '.mp4',
  'application/zip': '.zip',
  'application/x-zip': '.zip',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/octet-stream': '.bin',
};

function extensionFor(contentType: string, fallback: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[base] ?? EXT_BY_TYPE[fallback.split(';')[0].trim().toLowerCase()] ?? '.bin';
}

function readUpload(part: FilePart): { data: Buffer; filename: string } {
  const provided = part.filename?.trim();
  if (part.base64 !== undefined && part.base64 !== '') {
    let data: Buffer;
    try {
      data = Buffer.from(part.base64, 'base64');
    } catch {
      throw new ElevenLabsFileError(`${part.field}_base64 is not valid base64`);
    }
    // Buffer.from never throws on garbage, it just drops what it cannot decode, so
    // an empty result from a non-empty string is the only signal that it was junk.
    if (data.length === 0) {
      throw new ElevenLabsFileError(`${part.field}_base64 decoded to zero bytes`);
    }
    return { data, filename: provided || `${part.field}.bin` };
  }
  const p = part.path;
  if (!p) {
    throw new ElevenLabsFileError(`${part.field} needs either ${part.field}_path or ${part.field}_base64`);
  }
  const abs = resolve(p);
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) throw new Error('not a regular file');
    size = st.size;
  } catch (err) {
    throw new ElevenLabsFileError(
      `cannot read ${part.field}_path "${p}": ${err instanceof Error ? err.message : String(err)}. ` +
        'When this server runs in a container it cannot see your local disk — send ' +
        `${part.field}_base64 instead.`,
    );
  }
  const max = getMaxUploadBytes();
  if (size > max) {
    throw new ElevenLabsFileError(
      `${part.field}_path "${p}" is ${size} bytes, over the ${max} byte limit ` +
        '(raise ELEVENLABS_MAX_UPLOAD_BYTES if this is intended)',
    );
  }
  if (size === 0) throw new ElevenLabsFileError(`${part.field}_path "${p}" is empty`);
  return { data: readFileSync(abs), filename: provided || abs.split('/').pop() || `${part.field}.bin` };
}

/**
 * Where a binary response should land.
 *
 * An explicit output_path wins. A relative one resolves against ELEVENLABS_OUTPUT_DIR
 * when that is set, so an agent can say "voice.mp3" without knowing the deployment's
 * working directory. With neither, the caller gets null and the bytes travel inline.
 */
function resolveOutputPath(
  outputPath: string | undefined,
  contentType: string,
  primary: string,
  toolHint: string,
): string | null {
  const dir = getOutputDir();
  if (outputPath && outputPath.trim() !== '') {
    const raw = outputPath.trim();
    return isAbsolute(raw) ? raw : dir ? join(dir, raw) : resolve(raw);
  }
  if (!dir) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dir, `${toolHint}-${stamp}-${randomUUID().slice(0, 8)}${extensionFor(contentType, primary)}`);
}

function writeBinary(path: string, data: Buffer): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  } catch (err) {
    throw new ElevenLabsFileError(
      `cannot write "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ElevenLabsClient {
  /** Exposed so the server layer can report configuration without holding the key. */
  keyFingerprint(): string {
    return createHash('sha256').update(getApiKey()).digest('hex').slice(0, 8);
  }

  async request(opts: RequestOptions): Promise<unknown> {
    if (isDryRun() && opts.readOnly !== true) {
      return {
        dryRun: true,
        wouldSend: {
          method: opts.method,
          path: opts.path,
          query: opts.query ?? undefined,
          body: opts.body ?? undefined,
          form: opts.form ?? undefined,
          files: opts.files?.map((f) => f.field) ?? undefined,
        },
        note: 'ELEVENLABS_DRY_RUN=1 — nothing was sent and no credits were spent.',
      };
    }

    const url = new URL(getBaseUrl() + opts.path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      'xi-api-key': getApiKey(),
      accept: opts.binary ? '*/*' : 'application/json',
      'user-agent': '@aiwerk/mcp-server-elevenlabs',
    };

    let payload: BodyInit | undefined;
    if (opts.files && opts.files.length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(opts.form ?? {})) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      for (const part of opts.files) {
        const { data, filename } = readUpload(part);
        form.append(part.field, new Blob([new Uint8Array(data)]), filename);
      }
      payload = form; // fetch sets the multipart boundary itself
    } else if (opts.form && Object.keys(opts.form).length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(opts.form)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      payload = form;
    } else if (opts.body !== undefined && opts.method !== 'GET') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
      let res: Response;
      try {
        res = await fetch(url, {
          method: opts.method,
          headers,
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ElevenLabsTimeoutError(
            `${opts.method} ${opts.path} exceeded ${getTimeoutMs()}ms`,
          );
        }
        throw new ElevenLabsNetworkError(
          `${opts.method} ${opts.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timeout);
      }

      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const wait = retryDelayMs(res, attempt);
        if (wait !== null && wait <= getMaxRateLimitWaitMs()) {
          await sleep(wait);
          continue;
        }
      }

      if (!res.ok) throw await toError(res, opts);

      if (opts.binary) return await readBinary(res, opts);

      if (res.status === 204) return { ok: true, status: 204 };
      const text = await res.text();
      if (text === '') return { ok: true, status: res.status };
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text.slice(0, 10_000) };
      }
    }
  }
}

/** Seconds the server asked us to wait, or null when it did not say. */
function retryDelayMs(res: Response, attempt: number): number | null {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const secs = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  }
  // No header: back off anyway rather than hammering, but only briefly.
  return Math.min(1000 * 2 ** attempt, 4000);
}

async function readBinary(res: Response, opts: RequestOptions): Promise<BinaryResult> {
  const contentType = res.headers.get('content-type') ?? opts.binary?.primary ?? 'application/octet-stream';
  // A binary endpoint answering with JSON is an error envelope the API sent with a
  // 200, which happens on partial dubbing renders. Surface it as data, not bytes.
  if (contentType.includes('application/json')) {
    const text = await res.text();
    try {
      return JSON.parse(text) as BinaryResult;
    } catch {
      return { __binary: true, contentType, bytes: text.length, base64: Buffer.from(text).toString('base64') };
    }
  }

  const data = Buffer.from(await res.arrayBuffer());
  const toolHint = opts.path.split('/').filter(Boolean).slice(-2).join('-').replace(/[^a-z0-9-]/gi, '') || 'download';
  const target = resolveOutputPath(opts.outputPath, contentType, opts.binary?.primary ?? contentType, toolHint);

  const result: BinaryResult = {
    __binary: true,
    contentType: contentType.split(';')[0].trim(),
    bytes: data.length,
    requestId: res.headers.get('request-id') ?? undefined,
    characterCost: res.headers.get('character-cost') ?? undefined,
  };

  if (target) {
    writeBinary(target, data);
    result.path = target;
    return result;
  }

  const max = getMaxInlineBytes();
  if (data.length > max) {
    throw new ElevenLabsFileError(
      `response is ${data.length} bytes of ${result.contentType}, over the ${max} byte inline limit. ` +
        'Pass output_path to write it to a file, set ELEVENLABS_OUTPUT_DIR, or raise ' +
        'ELEVENLABS_MAX_INLINE_BYTES.',
    );
  }
  result.base64 = data.toString('base64');
  return result;
}

async function toError(res: Response, opts: RequestOptions): Promise<Error> {
  const text = await res.text().catch(() => '');
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    /* keep the text */
  }
  const safe = redactSecrets(body);
  const where = `${opts.method} ${opts.path}`;
  const detail = describe(safe);
  // Classify on the unredacted body: redaction exists to keep secrets out of what
  // the agent reads, not to decide what went wrong, and anything it rewrites here
  // silently changes the diagnosis.
  const status = detailStatus(body);

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    const secs = retryAfter ? Number.parseInt(retryAfter, 10) : null;
    return new ElevenLabsRateLimitError(
      res.status,
      res.statusText,
      safe,
      `Rate limited on ${where}${secs ? `, retry in ${secs}s` : ''}. ElevenLabs limits ` +
        'concurrent generations per plan tier.',
      Number.isFinite(secs as number) ? (secs as number) : null,
    );
  }

  if (res.status === 401 || res.status === 403) {
    if (status === 'quota_exceeded' || /quota/i.test(detail)) {
      return new ElevenLabsQuotaError(
        res.status,
        res.statusText,
        safe,
        `Out of credits on ${where}: ${detail}. Check the plan quota, and the key's own ` +
          'credit limit if one was set.',
      );
    }
    if (status === 'invalid_api_key' || status === 'missing_api_key') {
      return new ElevenLabsAuthError(
        res.status,
        res.statusText,
        safe,
        `Authentication failed on ${where}: ${detail}. Verify ELEVENLABS_API_KEY.`,
      );
    }
    if (/ip|allowlist|allow list/i.test(detail)) {
      return new ElevenLabsIpBlockedError(
        res.status,
        res.statusText,
        safe,
        `Rejected on ${where}: ${detail}. The key has an IP allowlist and this host is ` +
          'not on it — add the server\'s egress IP in the ElevenLabs key settings.',
      );
    }
    return new ElevenLabsScopeError(
      res.status,
      res.statusText,
      safe,
      `Not permitted on ${where}: ${detail}. An ElevenLabs key can be scope-restricted ` +
        'per endpoint group, so a valid key still gets rejected here — check the key\'s ' +
        'permissions, not just its value.',
    );
  }

  return new ElevenLabsApiError(
    res.status,
    res.statusText,
    safe,
    `${where} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
  );
}

/** ElevenLabs errors arrive as {detail: {status, message}} or {detail: "..."}. */
function detailStatus(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object' && typeof (detail as { status?: unknown }).status === 'string') {
    return (detail as { status: string }).status;
  }
  return null;
}

function describe(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 400);
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail.slice(0, 400);
  if (detail && typeof detail === 'object') {
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === 'string') return msg.slice(0, 400);
  }
  return JSON.stringify(body).slice(0, 400);
}
