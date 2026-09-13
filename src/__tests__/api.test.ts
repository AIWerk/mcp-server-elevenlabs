import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ElevenLabsClient, redactSecrets, isBinaryResult } from '../api.js';
import {
  ElevenLabsAuthError,
  ElevenLabsConfigError,
  ElevenLabsFileError,
  ElevenLabsIpBlockedError,
  ElevenLabsQuotaError,
  ElevenLabsRateLimitError,
  ElevenLabsScopeError,
  ElevenLabsTimeoutError,
} from '../errors.js';

const KEY = 'sk_testkey0000000000000000000000000';
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function binaryResponse(bytes: Buffer, contentType = 'audio/mpeg', headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType, ...headers } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'el-test-'));
  process.env.ELEVENLABS_API_KEY = KEY;
  delete process.env.ELEVENLABS_DRY_RUN;
  delete process.env.ELEVENLABS_OUTPUT_DIR;
  delete process.env.ELEVENLABS_MAX_INLINE_BYTES;
  delete process.env.ELEVENLABS_API_TIMEOUT_MS;
  delete process.env.ELEVENLABS_MAX_RATE_LIMIT_WAIT_MS;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('configuration', () => {
  it('refuses to run without an API key', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(new ElevenLabsClient().request({ method: 'GET', path: '/v1/user' })).rejects.toBeInstanceOf(
      ElevenLabsConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a nonsense timeout instead of silently using the default', async () => {
    process.env.ELEVENLABS_API_TIMEOUT_MS = 'soon';
    await expect(new ElevenLabsClient().request({ method: 'GET', path: '/v1/user' })).rejects.toThrow(
      /ELEVENLABS_API_TIMEOUT_MS/,
    );
  });

  it('sends the key as xi-api-key, never as a bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await new ElevenLabsClient().request({ method: 'GET', path: '/v1/user', readOnly: true });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
  });
});

describe('query building', () => {
  it('repeats array parameters and drops empty values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ElevenLabsClient().request({
      method: 'GET',
      path: '/v1/voices',
      readOnly: true,
      query: { voice_type: ['personal', 'community'], search: '', page_size: 30, only_mine: false },
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.getAll('voice_type')).toEqual(['personal', 'community']);
    expect(url.searchParams.has('search')).toBe(false);
    expect(url.searchParams.get('page_size')).toBe('30');
    // false is a meaningful filter value, not an absent one.
    expect(url.searchParams.get('only_mine')).toBe('false');
  });
});

describe('dry run', () => {
  it('blocks a write and reports what it would have sent', async () => {
    process.env.ELEVENLABS_DRY_RUN = '1';
    const out = (await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/text-to-speech/v1',
      body: { text: 'hello' },
    })) as { dryRun: boolean; wouldSend: { path: string } };
    expect(out.dryRun).toBe(true);
    expect(out.wouldSend.path).toBe('/v1/text-to-speech/v1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still performs reads', async () => {
    process.env.ELEVENLABS_DRY_RUN = '1';
    fetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    await new ElevenLabsClient().request({ method: 'GET', path: '/v1/models', readOnly: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('multipart uploads', () => {
  it('sends a file read from disk under its form field name', async () => {
    const file = join(dir, 'clip.mp3');
    writeFileSync(file, Buffer.from('ID3 fake audio payload'));
    fetchMock.mockResolvedValue(jsonResponse({ text: 'ok' }));

    await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/speech-to-text',
      form: { model_id: 'scribe_v1' },
      files: [{ field: 'file', path: file }],
    });

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('model_id')).toBe('scribe_v1');
    const sent = body.get('file');
    expect(sent).toBeInstanceOf(Blob);
    expect(await (sent as Blob).text()).toBe('ID3 fake audio payload');
    // fetch must set the multipart boundary itself.
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('accepts base64 for callers that cannot share a filesystem', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'ok' }));
    await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/speech-to-text',
      files: [{ field: 'file', base64: Buffer.from('inline bytes').toString('base64'), filename: 'a.mp3' }],
    });
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(await (body.get('file') as Blob).text()).toBe('inline bytes');
  });

  it('appends every entry of a repeated file field', async () => {
    const a = join(dir, 'a.mp3');
    const b = join(dir, 'b.mp3');
    writeFileSync(a, 'first');
    writeFileSync(b, 'second');
    fetchMock.mockResolvedValue(jsonResponse({ voice_id: 'v' }));

    await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/voices/add',
      form: { name: 'Test' },
      files: [
        { field: 'files', path: a },
        { field: 'files', path: b },
      ],
    });

    const body = fetchMock.mock.calls[0][1].body as FormData;
    const all = body.getAll('files');
    expect(all).toHaveLength(2);
    expect(await (all[0] as Blob).text()).toBe('first');
    expect(await (all[1] as Blob).text()).toBe('second');
  });

  it('explains the container case when a local path is missing', async () => {
    await expect(
      new ElevenLabsClient().request({
        method: 'POST',
        path: '/v1/speech-to-text',
        files: [{ field: 'file', path: join(dir, 'nope.mp3') }],
      }),
    ).rejects.toThrow(/file_base64 instead/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty file rather than uploading zero bytes', async () => {
    const empty = join(dir, 'empty.mp3');
    writeFileSync(empty, '');
    await expect(
      new ElevenLabsClient().request({
        method: 'POST',
        path: '/v1/speech-to-text',
        files: [{ field: 'file', path: empty }],
      }),
    ).rejects.toBeInstanceOf(ElevenLabsFileError);
  });
});

describe('binary responses', () => {
  const audio = Buffer.from('fake mp3 bytes'.repeat(10));

  it('writes to an absolute output path and reports it', async () => {
    fetchMock.mockResolvedValue(binaryResponse(audio, 'audio/mpeg', { 'character-cost': '18' }));
    const target = join(dir, 'nested', 'out.mp3');
    const res = await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/text-to-speech/v1',
      body: { text: 'x' },
      binary: { primary: 'audio/mpeg' },
      outputPath: target,
    });
    expect(isBinaryResult(res)).toBe(true);
    const r = res as { path?: string; bytes: number; characterCost?: string; base64?: string };
    expect(r.path).toBe(target);
    expect(readFileSync(target)).toEqual(audio);
    expect(r.bytes).toBe(audio.length);
    expect(r.characterCost).toBe('18');
    // Written to disk means it must NOT also travel through the model's context.
    expect(r.base64).toBeUndefined();
  });

  it('resolves a relative output path against ELEVENLABS_OUTPUT_DIR', async () => {
    process.env.ELEVENLABS_OUTPUT_DIR = dir;
    fetchMock.mockResolvedValue(binaryResponse(audio));
    const res = (await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/text-to-speech/v1',
      binary: { primary: 'audio/mpeg' },
      outputPath: 'clip.mp3',
    })) as { path?: string };
    expect(res.path).toBe(join(dir, 'clip.mp3'));
  });

  it('auto-names a file when only the output dir is set', async () => {
    process.env.ELEVENLABS_OUTPUT_DIR = dir;
    fetchMock.mockResolvedValue(binaryResponse(audio));
    const res = (await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/text-to-speech/abc',
      binary: { primary: 'audio/mpeg' },
    })) as { path?: string };
    expect(res.path).toMatch(/\.mp3$/);
    expect(readFileSync(res.path as string)).toEqual(audio);
  });

  it('returns base64 inline when there is nowhere to write', async () => {
    fetchMock.mockResolvedValue(binaryResponse(audio));
    const res = (await new ElevenLabsClient().request({
      method: 'POST',
      path: '/v1/text-to-speech/v1',
      binary: { primary: 'audio/mpeg' },
    })) as { base64?: string; path?: string };
    expect(res.path).toBeUndefined();
    expect(Buffer.from(res.base64 as string, 'base64')).toEqual(audio);
  });

  it('refuses to inline a payload over the limit and says how to fix it', async () => {
    process.env.ELEVENLABS_MAX_INLINE_BYTES = '10';
    fetchMock.mockResolvedValue(binaryResponse(audio));
    await expect(
      new ElevenLabsClient().request({
        method: 'POST',
        path: '/v1/text-to-speech/v1',
        binary: { primary: 'audio/mpeg' },
      }),
    ).rejects.toThrow(/output_path/);
  });

  it('surfaces a JSON error envelope sent with a 200 on a binary endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'still_processing' }));
    const res = (await new ElevenLabsClient().request({
      method: 'GET',
      path: '/v1/dubbing/x/audio/de',
      binary: { primary: 'audio/mpeg' },
      readOnly: true,
    })) as { status?: string };
    expect(res.status).toBe('still_processing');
  });
});

describe('error mapping', () => {
  const cases: [string, unknown, number, new (...a: never[]) => Error][] = [
    ['missing key', { detail: { status: 'missing_api_key', message: 'no key' } }, 401, ElevenLabsAuthError],
    ['invalid key', { detail: { status: 'invalid_api_key', message: 'bad key' } }, 401, ElevenLabsAuthError],
    ['quota', { detail: { status: 'quota_exceeded', message: 'out of credits' } }, 401, ElevenLabsQuotaError],
    ['ip allowlist', { detail: { status: 'forbidden', message: 'IP not in allowlist' } }, 401, ElevenLabsIpBlockedError],
    ['scope', { detail: { status: 'missing_permissions', message: 'key lacks text_to_speech' } }, 401, ElevenLabsScopeError],
  ];

  for (const [label, body, status, type] of cases) {
    it(`maps ${label} to ${type.name}`, async () => {
      fetchMock.mockResolvedValue(jsonResponse(body, status));
      await expect(
        new ElevenLabsClient().request({ method: 'GET', path: '/v1/user', readOnly: true }),
      ).rejects.toBeInstanceOf(type);
    });
  }

  it('retries a 429 that asks for a short wait, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ detail: 'slow down' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await new ElevenLabsClient().request({ method: 'GET', path: '/v1/models', readOnly: true });
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a 429 that asks for longer than we will wait', async () => {
    process.env.ELEVENLABS_MAX_RATE_LIMIT_WAIT_MS = '0';
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'slow down' }, 429, { 'retry-after': '600' }));
    const err = await new ElevenLabsClient()
      .request({ method: 'GET', path: '/v1/models', readOnly: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevenLabsRateLimitError);
    expect((err as ElevenLabsRateLimitError).resetSeconds).toBe(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout as a timeout, not a network failure', async () => {
    process.env.ELEVENLABS_API_TIMEOUT_MS = '5';
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    await expect(
      new ElevenLabsClient().request({ method: 'GET', path: '/v1/user', readOnly: true }),
    ).rejects.toBeInstanceOf(ElevenLabsTimeoutError);
  });
});

describe('redaction', () => {
  it('strips key-shaped values from strings, keys and nested objects', () => {
    const out = redactSecrets({
      message: `call failed with xi-api-key: ${KEY}`,
      api_key: KEY,
      nested: { authorization: 'Bearer abc.def', note: 'sk_0123456789abcdefghij is the key' },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain('sk_0123456789abcdefghij');
    expect(out.api_key).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[REDACTED]');
  });

  it('keeps the parts of an error that are worth reading', () => {
    const out = redactSecrets({ detail: 'voice_id not found' }) as { detail: string };
    expect(out.detail).toBe('voice_id not found');
  });
});
