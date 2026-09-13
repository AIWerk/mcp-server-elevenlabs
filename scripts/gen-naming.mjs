#!/usr/bin/env node
// Generates spec/elevenlabs-tool-naming.json from spec/elevenlabs-openapi.json.
//
// The naming table is the contract between the spec and the code generator: it fixes
// the tool name, the domain, the request shape (JSON vs multipart) and the response
// shape (JSON vs binary) for every operation, so those decisions are reviewable in a
// diff instead of being re-derived silently on each build.
//
// ElevenLabs ships clean, unique snake_case operationIds (390 of them, zero
// collisions), so the tool name is the operationId itself. No tag prefix: it would
// only make `text_to_speech_full` longer without making it clearer.
//
// Usage: node scripts/gen-naming.mjs [specPath] [outPath]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SPEC = process.argv[2] ?? join(root, 'spec/elevenlabs-openapi.json');
const OUT = process.argv[3] ?? join(root, 'spec/elevenlabs-tool-naming.json');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const doc = JSON.parse(readFileSync(SPEC, 'utf-8'));

function deref(node, seen = 0) {
  if (!node || typeof node !== 'object' || seen > 12) return node;
  if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) return node;
  let target = doc;
  for (const part of node.$ref.slice(2).split('/')) {
    target = target?.[part];
    if (target === undefined) return null;
  }
  return deref(target, seen + 1);
}

/** allOf/oneOf/anyOf branches carry properties on composed bodies. */
function properties(schema, seen = 0) {
  const base = deref(schema, seen);
  if (!base || typeof base !== 'object' || seen > 12) return {};
  const props = { ...(base.properties ?? {}) };
  for (const branch of base.allOf ?? base.oneOf ?? base.anyOf ?? []) {
    Object.assign(props, properties(branch, seen + 1));
  }
  return props;
}

/**
 * Domain slug used by ELEVENLABS_ENABLED_TAGS.
 *
 * Upstream tags are inconsistent in case and spacing ("Dubbing" and "dubbing" are
 * two tags for one product area), and 24 operations carry no tag at all. Both get
 * normalised here so the filter a user types matches what they see in the docs.
 */
function domainOf(op, path) {
  const raw = (op.tags ?? [])[0];
  if (raw) {
    return raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  // Untagged: fall back to the first meaningful path segment (/v1/foo/... -> foo).
  const seg = path.split('/').filter(Boolean);
  return (seg[1] ?? seg[0] ?? 'misc').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/**
 * Unwrap a field schema down to the branch that describes its real type.
 *
 * Every optional field in this spec is `anyOf: [T, {type: null}]`, and the binary
 * ones are no exception: `file` is anyOf[{string,format:binary}, null]. Reading
 * `.format` off the wrapper sees undefined, which is how a file field silently
 * becomes a plain string argument that sends the filename as text instead of the
 * audio. Voice cloning goes one further and takes an ARRAY of binaries.
 */
function unwrapField(rawProp) {
  const prop = deref(rawProp) ?? {};
  const branches = prop.anyOf ?? prop.oneOf ?? prop.allOf;
  let node = prop;
  let nullable = false;
  if (Array.isArray(branches)) {
    const nonNull = branches.map((b) => deref(b) ?? {}).filter((b) => b.type !== 'null');
    nullable = nonNull.length < branches.length;
    if (nonNull.length === 1) node = { ...nonNull[0], description: prop.description ?? nonNull[0].description };
    else node = { ...prop, type: nonNull[0]?.type };
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  nullable = nullable || types.includes('null');
  const scalarType = types.find((t) => t && t !== 'null');

  const isBinary = (n) => n?.format === 'binary' || n?.type === 'file';
  if (isBinary(node)) return { kind: 'file', multiple: false, nullable, node };
  if (scalarType === 'array' && isBinary(deref(node.items))) {
    return { kind: 'file', multiple: true, nullable, node };
  }
  return { kind: 'value', multiple: false, nullable, type: scalarType ?? 'string', node };
}

/**
 * How the request body is carried.
 *
 * 31 operations are multipart/form-data - speech-to-text, voice cloning, dubbing,
 * audio isolation, knowledge-base uploads. A JSON-only generator drops all of them,
 * which is how you end up with a 359-tool server missing the half of ElevenLabs
 * that takes audio in. They are kept, with every binary field exposed as a local
 * path or base64 argument.
 */
function bodyShape(op) {
  const content = op.requestBody?.content;
  if (!content) return { kind: 'none' };
  if (content['application/json']) return { kind: 'json' };
  if (content['multipart/form-data']) {
    const schema = content['multipart/form-data'].schema;
    const props = properties(schema);
    const required = new Set(deref(schema)?.required ?? []);
    const fields = [];
    for (const [name, rawProp] of Object.entries(props)) {
      const info = unwrapField(rawProp);
      const node = info.node;
      fields.push({
        name,
        binary: info.kind === 'file',
        multiple: info.multiple,
        required: required.has(name),
        type: info.kind === 'file' ? 'file' : info.type,
        nullable: info.nullable,
        enum: Array.isArray(node.enum) && node.enum.every((v) => typeof v === 'string') ? node.enum : null,
        description: (node.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      });
    }
    return { kind: 'multipart', fields };
  }
  return { kind: 'other', contentType: Object.keys(content)[0] };
}

/**
 * Does a success response carry bytes rather than JSON?
 *
 * 19 operations do, the text-to-speech endpoints among them. Parsing those as JSON
 * yields a mojibake string, so the client writes them to a file (or returns an MCP
 * audio block) instead — but only if the generated tool says the response is binary.
 */
function binaryResponse(op) {
  const types = new Set();
  for (const [code, res] of Object.entries(op.responses ?? {})) {
    if (!code.startsWith('2')) continue;
    for (const ct of Object.keys(res.content ?? {})) types.add(ct);
  }
  const binary = [...types].filter((ct) =>
    /^(audio|video|image)\//.test(ct) || /zip|octet-stream/.test(ct),
  );
  if (binary.length === 0) return null;
  // Prefer a concrete type over a wildcard for the default file extension.
  const concrete = binary.find((ct) => !ct.includes('*')) ?? binary[0];
  return { contentTypes: binary, primary: concrete };
}

/**
 * Operations that spend credits.
 *
 * Not an MCP annotation — there is no "costs money" hint — so it goes into the tool
 * description, where the agent actually reads it. A generation call that quietly
 * burns a quarter of a monthly quota is the kind of surprise worth one sentence.
 */
const BILLED_PATH = /^\/v1\/(text-to-speech|text-to-dialogue|text-to-voice|speech-to-speech|speech-to-text|sound-generation|audio-isolation|music|dubbing|forced-alignment|voice-generation|studio|productions|similar-voices)/;
function costsCredits(method, path) {
  return method !== 'GET' && method !== 'DELETE' && BILLED_PATH.test(path);
}

const ops = [];
for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;
    if (!op.operationId) throw new Error(`missing operationId: ${method} ${path}`);
    const upper = method.toUpperCase();
    ops.push({
      tool_name: op.operationId.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_|_$/g, '').toLowerCase(),
      domain: domainOf(op, path),
      operationId: op.operationId,
      method: upper,
      path,
      deprecated: op.deprecated === true,
      body: bodyShape(op),
      binaryResponse: binaryResponse(op),
      costsCredits: costsCredits(upper, path),
      summary: (op.summary ?? '').replace(/\s+/g, ' ').trim(),
      description: (op.description ?? '').replace(/\s+/g, ' ').trim(),
      annotations: {
        // Deliberately narrow: only GET is treated as a read. Several POSTs merely
        // query, but every one of them also spends credits, and dry-run gates on
        // this flag. An over-eager read classification would let a paid call through.
        readOnlyHint: upper === 'GET',
        destructiveHint: upper === 'DELETE',
        idempotentHint: ['GET', 'PUT', 'DELETE'].includes(upper),
      },
    });
  }
}

const seen = new Map();
for (const o of ops) {
  if (seen.has(o.tool_name)) {
    throw new Error(`duplicate tool_name ${o.tool_name}: ${o.method} ${o.path} vs ${seen.get(o.tool_name)}`);
  }
  seen.set(o.tool_name, `${o.method} ${o.path}`);
  if (o.tool_name.length > 64) throw new Error(`tool_name too long for MCP (${o.tool_name.length}): ${o.tool_name}`);
}

ops.sort((a, b) => a.tool_name.localeCompare(b.tool_name));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedFrom: 'https://api.elevenlabs.io/openapi.json',
      specVersion: doc.info?.version ?? null,
      count: ops.length,
      operations: ops,
    },
    null,
    2,
  ) + '\n',
);

const domains = new Set(ops.map((o) => o.domain));
const multipart = ops.filter((o) => o.body.kind === 'multipart').length;
const other = ops.filter((o) => o.body.kind === 'other');
const binary = ops.filter((o) => o.binaryResponse).length;
console.log(`${OUT}: ${ops.length} operations, ${domains.size} domains`);
console.log(`  multipart bodies: ${multipart} | binary responses: ${binary} | billed: ${ops.filter((o) => o.costsCredits).length} | deprecated: ${ops.filter((o) => o.deprecated).length}`);
if (other.length > 0) {
  console.log(`  ${other.length} body types neither JSON nor multipart:`);
  for (const o of other) console.log(`    ${o.tool_name} [${o.body.contentType}]`);
}
