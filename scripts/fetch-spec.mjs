#!/usr/bin/env node
// Downloads the live ElevenLabs OpenAPI document into spec/.
//
// The spec is committed, not fetched at build time: a generator that reaches the
// network mid-build produces a different package on every run, and a vendor edit
// then lands in a release nobody reviewed. Re-run this deliberately, read the diff,
// and commit it as its own change.
//
// Usage: node scripts/fetch-spec.mjs [url] [outPath]

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const URL_ = process.argv[2] ?? 'https://api.elevenlabs.io/openapi.json';
const OUT = process.argv[3] ?? join(root, 'spec/elevenlabs-openapi.json');

const res = await fetch(URL_, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const text = await res.text();
let doc;
try {
  doc = JSON.parse(text);
} catch (err) {
  console.error(`not valid JSON: ${err.message}`);
  process.exit(1);
}

const ops = Object.values(doc.paths ?? {}).reduce(
  (n, item) =>
    n + Object.keys(item).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length,
  0,
);
// A truncated or error-page download parses as JSON often enough to be worth a floor.
if (ops < 100) {
  console.error(`refusing to write: only ${ops} operations found, the spec should have hundreds`);
  process.exit(1);
}

const pretty = JSON.stringify(doc, null, 2) + '\n';
const newHash = createHash('sha256').update(pretty).digest('hex').slice(0, 12);
const oldHash = existsSync(OUT)
  ? createHash('sha256').update(readFileSync(OUT, 'utf-8')).digest('hex').slice(0, 12)
  : null;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, pretty);
console.log(`${OUT}: ${Object.keys(doc.paths ?? {}).length} paths, ${ops} operations, sha256:${newHash}`);
if (oldHash && oldHash !== newHash) {
  console.log(`  spec CHANGED (was sha256:${oldHash}) — review the diff and re-run gen-naming + gen-tools`);
} else if (oldHash) {
  console.log('  unchanged');
}
