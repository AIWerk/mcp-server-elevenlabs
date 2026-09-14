# @aiwerk/mcp-server-elevenlabs

An MCP server for the [ElevenLabs](https://elevenlabs.io) API. 390 tools, generated
from the live OpenAPI document, covering every documented endpoint.

## Why this exists

ElevenLabs ships its own MCP server. It is hosted, it authenticates with OAuth, and
it exposes about a dozen high-level tools for managing ElevenAgents plus one text to
speech call. That is a good fit for "create a support agent and set its voice".

This one is for the rest of the API. The whole of it:

| | Tools |
|---|---|
| ElevenLabs REST API (OpenAPI, live) | 390 operations |
| Official hosted MCP server | ~12 |
| Official local server (archived 2026-08) | 27 |
| This server | **390** |

It also handles the two things a generated client usually gets wrong: **31 endpoints
take file uploads** (speech to text, voice cloning, dubbing, audio isolation,
knowledge base) and **21 return raw bytes** (all the text to speech variants). Parsing
audio as JSON produces a plausible-looking string of mojibake, so those paths are
written by hand and tested.

What the official hosted server does better: OAuth means no API key is copied into
the client, and its agent tools are composed product logic rather than raw endpoints
("what would this agent cost per conversation on a different model" is not one API
call). Use both if that is what you need. They do not conflict.

## Install

```bash
npm install -g @aiwerk/mcp-server-elevenlabs
```

Or run it straight from npx in a client config:

```json
{
  "mcpServers": {
    "elevenlabs": {
      "command": "npx",
      "args": ["-y", "@aiwerk/mcp-server-elevenlabs"],
      "env": {
        "ELEVENLABS_API_KEY": "your-key",
        "ELEVENLABS_OUTPUT_DIR": "/where/audio/should/land"
      }
    }
  }
}
```

Get a key at <https://elevenlabs.io/app/settings/api-keys>. The free tier includes
10k credits a month.

### Keeping the key out of the config

An MCP client config is a plain file that tends to live in a repo or a dotfile, so a
key written into its `env` block is a key in cleartext. If you keep secrets in a
password manager, start the server through a small wrapper instead:

```bash
#!/usr/bin/env bash
set -euo pipefail
ELEVENLABS_API_KEY="$(pass show api/elevenlabs | head -1)"   # or your own manager
export ELEVENLABS_API_KEY
exec npx -y @aiwerk/mcp-server-elevenlabs@0.1.1 "$@"
```

```json
{
  "mcpServers": {
    "elevenlabs": {
      "command": "/path/to/the/wrapper",
      "env": { "ELEVENLABS_OUTPUT_DIR": "/where/audio/should/land" }
    }
  }
}
```

The secret is read at start-up and handed to the process as its own environment
variable, so it never appears in `argv` where other users on the machine could read
it. Note the pinned version: a bare `npx -y <package>` resolves to whatever is newest
at that moment, which is how an update lands in the middle of a production run.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | required | Sent as the `xi-api-key` header. |
| `ELEVENLABS_OUTPUT_DIR` | unset | Where generated audio lands. Without it, small results come back inline as base64 and large ones error. |
| `ELEVENLABS_ENABLED_DOMAINS` | all | Comma-separated domains, e.g. `text-to-speech,voices`. An unknown name is reported, not ignored. |
| `ELEVENLABS_HIDE_DEPRECATED` | `0` | `1` drops the 21 operations upstream marks deprecated. |
| `ELEVENLABS_DRY_RUN` | `0` | `1` blocks every non-GET call and returns what would have been sent. |
| `ELEVENLABS_API_TIMEOUT_MS` | `120000` | Generation is slow; a dubbing job outlives a CRUD timeout. |
| `ELEVENLABS_MAX_INLINE_BYTES` | `4194304` | Above this, a binary result needs somewhere to be written. |
| `ELEVENLABS_MAX_UPLOAD_BYTES` | `536870912` | Guards against reading an enormous file into memory. |
| `ELEVENLABS_MAX_RATE_LIMIT_WAIT_MS` | `10000` | Longest 429 backoff to sit through before failing. |
| `ELEVENLABS_API_BASE_URL` | `https://api.elevenlabs.io` | Point at a data-residency region if your workspace is in one. |

## Files in and out

**Uploads.** Every binary field is offered two ways:

```jsonc
// local install: the server can read your disk
{ "file_path": "/home/me/interview.mp3", "model_id": "scribe_v1" }

// containerised or remote: send the bytes
{ "file_base64": "SUQzB...", "file_filename": "interview.mp3", "model_id": "scribe_v1" }
```

Fields that accept several files (`add_voice`, `create_finetune`,
`add_pvc_voice_samples`) use `files_paths` / `files_base64_list` / `files_filenames`.

**Downloads.** Anything returning audio, video or a zip takes `output_path`:

```jsonc
{ "voice_id": "...", "text": "Guten Tag", "output_path": "greeting.mp3" }
// → { "contentType": "audio/mpeg", "bytes": 26375, "path": "/output/dir/greeting.mp3" }
```

A relative path resolves against `ELEVENLABS_OUTPUT_DIR`. With no path and no output
dir, the audio comes back as an MCP audio block, as long as it is under the inline
limit. Base64 inflates by a third and every byte crosses the model's context, so
prefer a file for anything longer than a sentence.

## Credits and safety

66 operations spend credits, and each one says so in its description. Nothing here
guesses on your behalf:

- `ELEVENLABS_DRY_RUN=1` blocks every write and generation call.
- Only `GET` is marked read-only. Several POSTs merely query, but every one of them
  also bills, so they are gated with the writes.
- `DELETE` operations carry `destructiveHint`.

An ElevenLabs key can be restricted per endpoint group, given its own credit quota
and locked to an IP range. All three failures arrive as HTTP 401, and this server
tells them apart, so "out of credits", "this key may not touch this endpoint" and
"this host is not on the allowlist" do not all read as "check your credentials".

## Regenerating from the spec

The spec is committed, not fetched at build time, so a vendor edit cannot land in a
release nobody reviewed.

```bash
npm run fetch-spec   # writes spec/elevenlabs-openapi.json, reports whether it changed
npm run regen        # naming table + generated tools
npm test
```

## Development

```bash
npm install
npm run build
npm test             # 47 unit tests
npm run smoke        # live test against the real API, spends a few credits
```

The smoke test does a round trip that the unit tests cannot: it generates speech to a
file, then uploads that same file back to speech-to-text and checks the words come
out again.

## License

MIT. Not affiliated with ElevenLabs.
