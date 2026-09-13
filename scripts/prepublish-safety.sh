#!/usr/bin/env bash
# Pre-publish safety check for @aiwerk/mcp-server-elevenlabs.
# Guards against wrong-CWD npm publish (npm ignores --prefix for publish).
set -euo pipefail

PACKAGE_JSON="${PWD}/package.json"
if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "prepublish-safety: no package.json in $PWD — refusing" >&2
  exit 1
fi

NAME=$(node -e "process.stdout.write(require('$PACKAGE_JSON').name || '')")
PRIVATE=$(node -e "process.stdout.write(String(require('$PACKAGE_JSON').private || false))")

if [[ "$PRIVATE" == "true" ]]; then
  echo "prepublish-safety: $NAME has private:true — refusing publish" >&2
  exit 1
fi

EXPECTED_NAME="@aiwerk/mcp-server-elevenlabs"
if [[ "$NAME" != "$EXPECTED_NAME" ]]; then
  echo "prepublish-safety: package name '$NAME' != '$EXPECTED_NAME' — wrong repo?" >&2
  exit 1
fi

CWD_BASE=$(basename "$PWD")
if [[ "$CWD_BASE" != "mcp-server-elevenlabs" ]]; then
  echo "prepublish-safety: CWD basename '$CWD_BASE' != 'mcp-server-elevenlabs' — wrong directory" >&2
  exit 1
fi

echo "prepublish-safety: OK ($NAME at $PWD)"
