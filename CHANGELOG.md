# Changelog

All notable changes to `@aiwerk/mcp-server-elevenlabs`.

## [0.1.0] - 2026-09-13

First release.

### Added
- 390 tools covering every operation in the live ElevenLabs OpenAPI document,
  across 35 API domains: text to speech, speech to text, speech to speech,
  dubbing, music, studio, voices and PVC, ElevenAgents, workspace, pronunciation
  dictionaries, audio isolation, forced alignment and the rest.
- File uploads on all 31 multipart operations. Every binary field takes either a
  local path (`<field>_path`) or inline bytes (`<field>_base64`), because a
  server installed locally can read the caller's disk and one running in a
  container cannot. Repeated file fields (voice cloning samples, fine-tune data)
  take arrays.
- Binary downloads on all 21 operations that return audio, video or zip. Bytes go
  to `output_path`, or to `ELEVENLABS_OUTPUT_DIR` under a generated name, or come
  back inline as an MCP audio block when they are small enough to be worth it.
- Credit warnings in the description of all 66 operations that spend credits.
- `ELEVENLABS_DRY_RUN=1` blocks every non-GET call and reports what would have
  been sent, so a workflow can be rehearsed without spending anything.
- `ELEVENLABS_ENABLED_DOMAINS` narrows the tool surface for clients wired
  directly to the server rather than through a router.
- Distinct errors for the four ways an ElevenLabs 401 can happen: bad key,
  missing scope on a scope-restricted key, IP allowlist, and exhausted credits.
