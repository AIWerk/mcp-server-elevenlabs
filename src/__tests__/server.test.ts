import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDeprecationFilter, binaryContent, createServer, selectTools, toolError } from '../server.js';
import { generatedTools, type GeneratedTool } from '../tools/generated.js';
import { ElevenLabsConfigError, ElevenLabsQuotaError, ElevenLabsFileError } from '../errors.js';

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = 'sk_test000000000000000000000000000';
  delete process.env.ELEVENLABS_ENABLED_DOMAINS;
  delete process.env.ELEVENLABS_HIDE_DEPRECATED;
});
afterEach(() => {
  delete process.env.ELEVENLABS_ENABLED_DOMAINS;
  delete process.env.ELEVENLABS_HIDE_DEPRECATED;
});

describe('generated surface', () => {
  it('covers every operation in the spec', () => {
    // The naming table is the contract; a silent drop shows up here as a count change.
    expect(generatedTools.length).toBe(390);
  });

  it('has unique, MCP-legal tool names', () => {
    const names = generatedTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^[a-z0-9_]+$/);
      expect(n.length).toBeLessThanOrEqual(64);
    }
  });

  it('exposes uploads as path and base64, never as a bare file argument', () => {
    const stt = generatedTools.find((t) => t.name === 'speech_to_text');
    const shape = Object.keys((stt?.inputSchema as { shape: Record<string, unknown> }).shape);
    expect(shape).toContain('file_path');
    expect(shape).toContain('file_base64');
    // A plain `file` string would send the filename as text and transcribe nothing.
    expect(shape).not.toContain('file');
  });

  it('exposes a repeated upload field as arrays', () => {
    const add = generatedTools.find((t) => t.name === 'add_voice');
    const shape = Object.keys((add?.inputSchema as { shape: Record<string, unknown> }).shape);
    expect(shape).toContain('files_paths');
    expect(shape).toContain('files_base64_list');
  });

  it('gives every binary-returning tool an output_path and says so', () => {
    const tts = generatedTools.find((t) => t.name === 'text_to_speech_full');
    const shape = Object.keys((tts?.inputSchema as { shape: Record<string, unknown> }).shape);
    expect(shape).toContain('output_path');
    expect(tts?.description).toMatch(/output_path/);
  });

  it('warns about credit spend on generation tools but not on reads', () => {
    const tts = generatedTools.find((t) => t.name === 'text_to_speech_full');
    const voices = generatedTools.find((t) => t.name === 'get_voices');
    expect(tts?.costsCredits).toBe(true);
    expect(tts?.description).toMatch(/credits/i);
    expect(voices?.costsCredits).toBe(false);
    expect(voices?.description).not.toMatch(/credits/i);
  });

  it('marks only GET as read-only, so dry-run cannot leak a paid call', () => {
    const paid = generatedTools.filter((t) => t.costsCredits);
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((t) => t.annotations.readOnlyHint === false)).toBe(true);
  });

  it('flags deletes as destructive', () => {
    const del = generatedTools.find((t) => t.name === 'delete_voice');
    expect(del?.annotations.destructiveHint).toBe(true);
  });
});

describe('domain filtering', () => {
  const fake = (name: string, domain: string, deprecated = false) =>
    ({ name, domain, deprecated }) as GeneratedTool;

  it('passes everything through when unset', () => {
    const all = [fake('a', 'voices'), fake('b', 'dubbing')];
    expect(selectTools(all, undefined).selected).toHaveLength(2);
    expect(selectTools(all, '   ').selected).toHaveLength(2);
  });

  it('selects by domain, case-insensitively', () => {
    const all = [fake('a', 'voices'), fake('b', 'dubbing')];
    const { selected, unknown } = selectTools(all, 'VOICES');
    expect(selected.map((t) => t.name)).toEqual(['a']);
    expect(unknown).toEqual([]);
  });

  it('reports an unknown domain instead of silently hiding the API', () => {
    const all = [fake('a', 'voices')];
    expect(selectTools(all, 'voices,voises').unknown).toEqual(['voises']);
  });

  it('drops deprecated operations only when asked', () => {
    const all = [fake('a', 'voices'), fake('b', 'voices', true)];
    expect(applyDeprecationFilter(all, false)).toHaveLength(2);
    expect(applyDeprecationFilter(all, true).map((t) => t.name)).toEqual(['a']);
  });

  it('refuses to start on a filter that matches nothing', () => {
    process.env.ELEVENLABS_ENABLED_DOMAINS = 'not-a-domain';
    expect(() => createServer()).toThrow(ElevenLabsConfigError);
  });

  it('starts with the full surface by default', () => {
    const { toolCount } = createServer();
    expect(toolCount).toBe(390);
  });

  it('narrows the surface when a real domain is named', () => {
    process.env.ELEVENLABS_ENABLED_DOMAINS = 'text-to-speech';
    const { toolCount } = createServer();
    expect(toolCount).toBeGreaterThan(0);
    expect(toolCount).toBeLessThan(20);
  });
});

describe('binary result rendering', () => {
  it('reports a written file as text, without inlining the bytes', () => {
    const out = binaryContent({
      __binary: true,
      contentType: 'audio/mpeg',
      bytes: 1234,
      path: '/tmp/out.mp3',
      characterCost: '42',
    });
    expect(out.content).toHaveLength(1);
    const summary = JSON.parse((out.content[0] as { text: string }).text);
    expect(summary.path).toBe('/tmp/out.mp3');
    expect(summary.characterCost).toBe('42');
  });

  it('returns an audio block alongside the summary when inlined', () => {
    const out = binaryContent({
      __binary: true,
      contentType: 'audio/mpeg',
      bytes: 3,
      base64: Buffer.from('abc').toString('base64'),
    });
    expect(out.content.map((c) => c.type)).toEqual(['text', 'audio']);
    const audio = out.content[1] as { data: string; mimeType: string };
    expect(audio.mimeType).toBe('audio/mpeg');
    expect(Buffer.from(audio.data, 'base64').toString()).toBe('abc');
  });
});

describe('error surfacing', () => {
  it('keeps the recovery hint on a quota error', () => {
    const out = toolError(new ElevenLabsQuotaError(401, 'Unauthorized', null, 'Out of credits: check the plan quota'));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/plan quota/);
  });

  it('labels a file problem as one', () => {
    const out = toolError(new ElevenLabsFileError('cannot read file_path "/nope"'));
    expect(out.content[0].text).toMatch(/^File error/);
  });

  it('does not crash on a non-Error throw', () => {
    expect(toolError('plain string').content[0].text).toBe('plain string');
  });
});
