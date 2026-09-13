#!/usr/bin/env node
// Live smoke test against the real ElevenLabs API. Spends a small number of credits.
//
// The point is the two paths a generated OpenAPI client cannot get right on its own:
// a binary response written to disk, and a multipart upload of that same file back
// up. Everything else here is a cheap read.
//
// Usage: node scripts/live-smoke.mjs [--keep]

import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToken, startServer, connect, callTool } from './lib/mcp-harness.mjs';

const KEEP = process.argv.includes('--keep');
const outDir = mkdtempSync(join(tmpdir(), 'elevenlabs-smoke-'));

const key = readToken('api/elevenlabs');
const child = startServer(key, { ELEVENLABS_OUTPUT_DIR: outDir });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  const { call, init } = await connect(child);
  console.log(`\nserver: ${init.serverInfo.name} v${init.serverInfo.version}`);

  const list = await call('tools/list', {});
  check('tools/list', list.tools.length > 300, `${list.tools.length} tools`);

  // --- reads ---------------------------------------------------------------
  const user = await callTool(call, 'get_user_info', {});
  check('get_user_info', user.ok && !!user.data?.subscription, user.ok ? `tier ${user.data?.subscription?.tier}` : user.error);

  const models = await callTool(call, 'get_models', {});
  check('get_models', models.ok && Array.isArray(models.data), models.ok ? `${models.data.length} models` : models.error);

  const voices = await callTool(call, 'get_voices', {});
  const voiceId = voices.ok ? voices.data?.voices?.[0]?.voice_id : null;
  check('get_voices', !!voiceId, voiceId ? `first voice ${voiceId}` : voices.error);

  // --- binary response written to disk -------------------------------------
  let mp3 = null;
  if (voiceId) {
    const tts = await callTool(call, 'text_to_speech_full', {
      voice_id: voiceId,
      text: 'AIWerk smoke test.',
      model_id: 'eleven_multilingual_v2',
      output_path: 'smoke.mp3',
    });
    mp3 = tts.ok ? tts.data?.path : null;
    const size = mp3 ? statSync(mp3).size : 0;
    check('text_to_speech_full → file', !!mp3 && size > 1000, mp3 ? `${size} bytes at ${mp3}` : tts.error);
  }

  // --- multipart upload of that file ---------------------------------------
  if (mp3) {
    const stt = await callTool(call, 'speech_to_text', {
      file_path: mp3,
      model_id: 'scribe_v1',
    });
    const text = stt.ok ? String(stt.data?.text ?? '') : '';
    check('speech_to_text ← same file', stt.ok && /aiwerk|smoke/i.test(text), stt.ok ? JSON.stringify(text.slice(0, 60)) : stt.error);
  }

  // --- error shape ---------------------------------------------------------
  // A wrong tool name here would also come back as !ok, which is how this check
  // passed once while proving nothing. Assert that the failure came from the API.
  const bad = await callTool(call, 'get_voice_by_id', { voice_id: 'definitely-not-a-voice' });
  const fromApi = !bad.ok && /GET \/v1\/voices/.test(bad.error) && !/not found: tool|Tool .* not found/i.test(bad.error);
  check('unknown id → API error, not a typo', fromApi, bad.ok ? 'unexpectedly succeeded' : bad.error.slice(0, 90));

  // --- dry run -------------------------------------------------------------
  const dryChild = startServer(key, { ELEVENLABS_DRY_RUN: '1' });
  const dry = await connect(dryChild);
  const dryTts = await callTool(dry.call, 'text_to_speech_full', {
    voice_id: voiceId ?? 'x',
    text: 'should not be sent',
  });
  check('dry run blocks a paid call', dryTts.ok && dryTts.data?.dryRun === true);
  dryChild.kill();
} finally {
  child.kill();
  if (!KEEP) rmSync(outDir, { recursive: true, force: true });
  else console.log(`\noutput kept in ${outDir}`);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
