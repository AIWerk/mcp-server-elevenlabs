#!/usr/bin/env node
// Generates src/tools/generated.ts from:
//   - spec/elevenlabs-openapi.json          (live ElevenLabs OpenAPI 3.1, fetched by fetch-spec.mjs)
//   - spec/elevenlabs-tool-naming.json      (390 ops: tool name, domain, body shape, response shape)
//
// Every path, verb and field name in the output comes from the spec. Hand-written
// clients drift: they call routes that no longer exist or advertise fields the API
// rejects. Nothing here is written by hand, so that drift cannot be introduced.
//
// Two things the spec cannot express as plain JSON arguments, handled explicitly:
//   - multipart uploads  -> every binary field becomes <field>_path / <field>_base64
//                           / <field>_filename, and the client builds the FormData.
//   - binary responses   -> the tool takes output_path and the client writes the
//                           bytes, instead of parsing audio as JSON.
//
// Usage: node scripts/generate-tools.mjs [specPath] [namingPath] [outPath]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SPEC_PATH = process.argv[2] ?? join(root, 'spec/elevenlabs-openapi.json');
const NAMING_PATH = process.argv[3] ?? join(root, 'spec/elevenlabs-tool-naming.json');
const OUT_PATH = process.argv[4] ?? join(root, 'src/tools/generated.ts');

const doc = JSON.parse(readFileSync(SPEC_PATH, 'utf-8'));
const naming = JSON.parse(readFileSync(NAMING_PATH, 'utf-8'));

/** Deepest level at which object properties are still expanded into a zod shape. */
const MAX_SCHEMA_DEPTH = 2;

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

function resolveRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = doc;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part];
    if (node === undefined) return null;
  }
  return node;
}

function deref(schema, seen = 0) {
  if (!schema || typeof schema !== 'object' || seen > 12) return schema;
  if (schema.$ref) return deref(resolveRef(schema.$ref), seen + 1);
  return schema;
}

/**
 * Resolve refs AND collapse allOf/oneOf/anyOf into one object schema.
 * allOf is an intersection: properties merge, required is the union.
 * oneOf/anyOf are alternatives: properties are offered, nothing is required,
 * because no single branch is known to apply.
 *
 * OpenAPI 3.1 also spells nullability as anyOf:[T, {type:'null'}], which would
 * otherwise flatten into a propertyless object. Those collapse to T instead.
 */
function flatten(schema, seen = 0) {
  const base = deref(schema, seen);
  if (!base || typeof base !== 'object' || seen > 12) return base;

  const composed = base.allOf ?? base.oneOf ?? base.anyOf;
  if (!Array.isArray(composed) || composed.length === 0) return base;

  const nonNull = composed.filter((b) => deref(b)?.type !== 'null');
  if (nonNull.length === 1 && !Array.isArray(base.allOf)) {
    const only = flatten(nonNull[0], seen + 1);
    return { ...only, nullable: composed.length > nonNull.length ? true : only?.nullable };
  }

  const isIntersection = Array.isArray(base.allOf);
  const merged = {
    ...base,
    type: 'object',
    properties: { ...(base.properties ?? {}) },
    required: [...(base.required ?? [])],
  };
  delete merged.allOf;
  delete merged.oneOf;
  delete merged.anyOf;

  for (const branchRaw of nonNull) {
    const branch = flatten(branchRaw, seen + 1);
    if (!branch || typeof branch !== 'object') continue;
    Object.assign(merged.properties, branch.properties ?? {});
    if (isIntersection && Array.isArray(branch.required)) merged.required.push(...branch.required);
  }
  merged.required = isIntersection ? [...new Set(merged.required)] : [];
  if (composed.length > nonNull.length) merged.nullable = true;
  return merged;
}

const jsIdent = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));
const jsAccess = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);

function quote(text) {
  return JSON.stringify(String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300));
}

function camel(snake) {
  return snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// JSON Schema -> zod source text
// ---------------------------------------------------------------------------

function zodFor(rawSchema, depth = 0) {
  const schema = flatten(rawSchema);
  if (!schema || typeof schema !== 'object') return 'z.unknown()';

  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes('null');
    type = type.find((t) => t !== 'null');
  }

  let out;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    out = schema.enum.every((v) => typeof v === 'string')
      ? `z.enum([${schema.enum.map((v) => JSON.stringify(v)).join(', ')}])`
      : 'z.unknown()';
  } else if (type === 'array') {
    out = `z.array(${depth >= MAX_SCHEMA_DEPTH ? 'z.unknown()' : zodFor(schema.items, depth + 1)})`;
  } else if (type === 'object' || schema.properties) {
    out = depth >= MAX_SCHEMA_DEPTH || !schema.properties
      ? 'z.record(z.unknown())'
      : objectShape(schema, depth + 1);
  } else if (type === 'string') {
    out = 'z.string()';
  } else if (type === 'integer' || type === 'number') {
    out = 'z.number()';
  } else if (type === 'boolean') {
    out = 'z.boolean()';
  } else {
    out = 'z.unknown()';
  }
  if (nullable) out += '.nullable()';
  return out;
}

function objectShape(schema, depth) {
  const required = new Set(schema.required ?? []);
  const fields = [];
  for (const [name, propRaw] of Object.entries(schema.properties ?? {})) {
    const prop = flatten(propRaw);
    if (prop?.readOnly === true) continue;
    let expr = zodFor(prop, depth);
    if (!required.has(name)) expr += '.optional()';
    if (prop?.description) expr += `.describe(${quote(prop.description)})`;
    fields.push(`  ${jsIdent(name)}: ${expr},`);
  }
  return fields.length > 0 ? `z.object({\n${fields.join('\n')}\n})` : 'z.record(z.unknown())';
}

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

const OUTPUT_PATH_NOTE =
  'Where to write the returned bytes. Relative paths resolve against ELEVENLABS_OUTPUT_DIR. ' +
  'Omit it to get the data inline as base64 (small files only).';

function buildTool(op) {
  const pathItem = doc.paths?.[op.path];
  const operation = pathItem?.[op.method.toLowerCase()];
  if (!operation) return null;

  const allParams = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((p) => deref(p))
    .filter(Boolean);

  // xi-api-key travels on every request from the client, never from the agent.
  const usable = allParams.filter(
    (p) => p.in !== 'header' || !/^(xi-api-key|authorization)$/i.test(p.name ?? ''),
  );
  const pathParams = usable.filter((p) => p.in === 'path');
  const queryParams = usable.filter((p) => p.in === 'query');
  const headerParams = usable.filter((p) => p.in === 'header');

  const fields = [];
  const seen = new Set();

  for (const p of [...pathParams, ...queryParams, ...headerParams]) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    let expr = zodFor(p.schema ?? { type: 'string' }, 1);
    // A path parameter is interpolated unconditionally: making it optional because
    // the spec forgot `required` produces a request to a path containing "undefined".
    const optional = !p.required && p.in !== 'path';
    if (optional) expr += '.optional()';
    if (p.description) expr += `.describe(${quote(p.description)})`;
    fields.push(`  ${jsIdent(p.name)}: ${expr},`);
  }

  // Path placeholders the spec forgot to declare as parameters.
  for (const name of op.path.match(/\{([^}]+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
    if (seen.has(name)) continue;
    seen.add(name);
    fields.push(`  ${jsIdent(name)}: z.string().describe(${quote(`Path parameter ${name}.`)}),`);
  }

  // --- body -----------------------------------------------------------------
  const jsonBodyFields = [];
  const formFields = [];
  const fileFields = [];
  let jsonPassthrough = false;

  if (op.body.kind === 'json') {
    const bodyRaw = operation.requestBody?.content?.['application/json']?.schema;
    const bodySchema = flatten(bodyRaw);
    const required = new Set(bodySchema?.required ?? []);
    const props = Object.entries(bodySchema?.properties ?? {});
    for (const [name, propRaw] of props) {
      const prop = flatten(propRaw);
      if (prop?.readOnly === true) continue;
      if (seen.has(name)) {
        console.error(`  NOTE ${op.tool_name}: body field "${name}" shadowed by a path/query parameter`);
        continue;
      }
      seen.add(name);
      jsonBodyFields.push(name);
      let expr = zodFor(prop, 1);
      if (!required.has(name)) expr += '.optional()';
      if (prop?.description) expr += `.describe(${quote(prop.description)})`;
      fields.push(`  ${jsIdent(name)}: ${expr},`);
    }
    if (props.length === 0 && bodyRaw) {
      // A body with no named properties (a bare array, or a free-form object) still
      // has to be sendable, so it is offered as one opaque argument.
      jsonPassthrough = true;
      seen.add('body');
      const expr = bodySchema?.type === 'array' ? 'z.array(z.unknown())' : 'z.record(z.unknown())';
      fields.push(`  body: ${expr}.describe("Request body as defined by the ElevenLabs API."),`);
    }
  } else if (op.body.kind === 'multipart') {
    for (const f of op.body.fields) {
      if (f.binary) {
        // Two ways in, because the two deployments differ: a local install can read
        // the user's disk, a containerised one cannot see it at all. Voice cloning
        // and fine-tuning take a list of samples on one field, so those get arrays.
        const base = f.name;
        fileFields.push({ field: base, multiple: f.multiple === true });
        const req = f.required ? ' Required for this call.' : '';
        const many = f.multiple === true;
        const str = many ? 'z.array(z.string())' : 'z.string()';
        const pathName = many ? `${base}_paths` : `${base}_path`;
        const b64Name = many ? `${base}_base64_list` : `${base}_base64`;
        const nameName = many ? `${base}_filenames` : `${base}_filename`;
        fields.push(
          `  ${jsIdent(pathName)}: ${str}.optional().describe(${quote(
            `${f.description || `File for "${base}".`} Local ${many ? 'paths' : 'path'}.${req}`,
          )}),`,
        );
        fields.push(
          `  ${jsIdent(b64Name)}: ${str}.optional().describe(${quote(
            `Base64 contents for "${base}"${many ? ', one entry per file' : ''}. Use this when the server cannot read your local disk.`,
          )}),`,
        );
        fields.push(
          `  ${jsIdent(nameName)}: ${str}.optional().describe(${quote(
            `${many ? 'Filenames' : 'Filename'} to send for "${base}". Some endpoints infer the audio format from ${many ? 'them' : 'it'}.`,
          )}),`,
        );
        seen.add(pathName);
        seen.add(b64Name);
        seen.add(nameName);
        continue;
      }
      if (seen.has(f.name)) {
        console.error(`  NOTE ${op.tool_name}: form field "${f.name}" shadowed by a path/query parameter`);
        continue;
      }
      seen.add(f.name);
      formFields.push(f.name);
      let expr;
      if (f.enum) expr = `z.enum([${f.enum.map((v) => JSON.stringify(v)).join(', ')}])`;
      else if (f.type === 'integer' || f.type === 'number') expr = 'z.number()';
      else if (f.type === 'boolean') expr = 'z.boolean()';
      else if (f.type === 'object') expr = 'z.record(z.unknown())';
      else if (f.type === 'array') expr = 'z.array(z.unknown())';
      else expr = 'z.string()';
      if (f.nullable) expr += '.nullable()';
      if (!f.required) expr += '.optional()';
      if (f.description) expr += `.describe(${quote(f.description)})`;
      fields.push(`  ${jsIdent(f.name)}: ${expr},`);
    }
  }

  if (op.binaryResponse) {
    seen.add('output_path');
    fields.push(`  output_path: z.string().optional().describe(${quote(OUTPUT_PATH_NOTE)}),`);
  }

  const inputName = `${camel(op.tool_name)}Input`;
  const fnName = camel(op.tool_name);
  const shape = fields.length > 0 ? `z.object({\n${fields.join('\n')}\n})` : 'z.object({})';

  const lines = [];
  lines.push(`export const ${inputName} = ${shape};`);
  lines.push(
    `export async function ${fnName}(client: ElevenLabsClient, args: z.infer<typeof ${inputName}>): Promise<unknown> {`,
  );

  const pathExpr = op.path.includes('{')
    ? '`' +
      op.path.replace(
        /\{([^}]+)\}/g,
        (_, n) => '${encodeURIComponent(String(args' + jsAccess(n) + '))}',
      ) +
      '`'
    : JSON.stringify(op.path);
  lines.push(`  const path = ${pathExpr};`);

  const queryNames = queryParams.map((p) => p.name);
  const csvNames = queryParams
    .filter((p) => (deref(p.schema) ?? {}).type === 'array' && p.explode === false)
    .map((p) => p.name);
  if (queryNames.length > 0) {
    lines.push(
      `  const query = pickQuery(args, [${queryNames.map((n) => JSON.stringify(n)).join(', ')}], [${csvNames
        .map((n) => JSON.stringify(n))
        .join(', ')}]);`,
    );
  }

  if (jsonPassthrough) {
    lines.push(`  const body = args.body;`);
  } else if (jsonBodyFields.length > 0) {
    lines.push(`  const body = pick(args, [${jsonBodyFields.map((n) => JSON.stringify(n)).join(', ')}]);`);
  }
  if (formFields.length > 0) {
    lines.push(`  const form = pick(args, [${formFields.map((n) => JSON.stringify(n)).join(', ')}]);`);
  }
  if (fileFields.length > 0) {
    lines.push(
      `  const files = collectFiles(args, [${fileFields
        .map((f) => `{ field: ${JSON.stringify(f.field)}, multiple: ${f.multiple} }`)
        .join(', ')}]);`,
    );
  }

  lines.push(`  return client.request({`);
  lines.push(`    method: ${JSON.stringify(op.method)},`);
  lines.push(`    path,`);
  if (queryNames.length > 0) lines.push(`    query,`);
  if (jsonPassthrough || jsonBodyFields.length > 0) lines.push(`    body,`);
  if (formFields.length > 0) lines.push(`    form,`);
  if (fileFields.length > 0) lines.push(`    files,`);
  if (op.binaryResponse) {
    lines.push(`    binary: { primary: ${JSON.stringify(op.binaryResponse.primary)} },`);
    lines.push(`    outputPath: args.output_path,`);
  }
  if (op.annotations.readOnlyHint) lines.push(`    readOnly: true,`);
  lines.push(`  });`);
  lines.push(`}`);

  return { source: lines.join('\n'), fnName, inputName };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const byDomain = new Map();
const registry = [];
let missing = 0;

for (const op of naming.operations) {
  const built = buildTool(op);
  if (!built) {
    missing++;
    console.error(`  SKIP ${op.tool_name}: ${op.method} ${op.path} not found in the spec`);
    continue;
  }
  if (!byDomain.has(op.domain)) byDomain.set(op.domain, []);
  byDomain.get(op.domain).push(built.source);

  const parts = [(op.summary || op.description || op.tool_name).replace(/\s+/g, ' ').trim()];
  if (op.costsCredits) parts.push('Spends ElevenLabs credits.');
  if (op.deprecated) parts.push('Deprecated upstream.');
  if (op.binaryResponse) parts.push(`Returns ${op.binaryResponse.primary} bytes; pass output_path to save them.`);
  registry.push({
    name: op.tool_name,
    fn: built.fnName,
    input: built.inputName,
    description: parts.join(' ').slice(0, 400),
    domain: op.domain,
    annotations: op.annotations,
    costsCredits: op.costsCredits,
    deprecated: op.deprecated,
  });
}

const parts = [];
parts.push(`// AUTO-GENERATED by scripts/generate-tools.mjs — do not edit by hand.`);
parts.push(`// Source: ${naming.generatedFrom}`);
parts.push(`// Re-generate with: npm run gen-tools`);
parts.push(`//`);
parts.push(`// ${registry.length} tools across ${byDomain.size} ElevenLabs API domains.`);
parts.push(``);
parts.push(`import { z } from 'zod';`);
parts.push(`import type { ElevenLabsClient, FilePart, Query } from '../api.js';`);
parts.push(``);
parts.push(`/** Copy only the named keys that were actually provided. */`);
parts.push(`function pick<T extends Record<string, unknown>>(source: T, keys: string[]): Record<string, unknown> {`);
parts.push(`  const out: Record<string, unknown> = {};`);
parts.push(`  for (const key of keys) {`);
parts.push(`    const value = (source as Record<string, unknown>)[key];`);
parts.push(`    if (value !== undefined) out[key] = value;`);
parts.push(`  }`);
parts.push(`  return out;`);
parts.push(`}`);
parts.push(``);
parts.push(`/**`);
parts.push(` * Gather the per-field file arguments back into uploads.`);
parts.push(` *`);
parts.push(` * A field the caller left out entirely is skipped, so an optional file stays`);
parts.push(` * optional. One given both ways prefers the inline bytes, since those cannot`);
parts.push(` * have gone stale on someone else's disk. List-valued fields (voice cloning`);
parts.push(` * samples, fine-tune data) produce one upload per entry, all under the same`);
parts.push(` * form field name, which is what multipart expects for a repeated file.`);
parts.push(` */`);
parts.push(`function collectFiles<T extends Record<string, unknown>>(`);
parts.push(`  source: T,`);
parts.push(`  fields: { field: string; multiple: boolean }[],`);
parts.push(`): FilePart[] {`);
parts.push(`  const out: FilePart[] = [];`);
parts.push(`  const src = source as Record<string, unknown>;`);
parts.push(`  const strings = (v: unknown): string[] =>`);
parts.push(`    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];`);
parts.push(`  for (const { field, multiple } of fields) {`);
parts.push(`    if (multiple) {`);
parts.push(`      const paths = strings(src[\`\${field}_paths\`]);`);
parts.push(`      const b64 = strings(src[\`\${field}_base64_list\`]);`);
parts.push(`      const names = strings(src[\`\${field}_filenames\`]);`);
parts.push(`      const count = Math.max(paths.length, b64.length);`);
parts.push(`      for (let i = 0; i < count; i++) {`);
parts.push(`        out.push({ field, path: paths[i], base64: b64[i], filename: names[i] });`);
parts.push(`      }`);
parts.push(`      continue;`);
parts.push(`    }`);
parts.push(`    const path = src[\`\${field}_path\`];`);
parts.push(`    const base64 = src[\`\${field}_base64\`];`);
parts.push(`    const filename = src[\`\${field}_filename\`];`);
parts.push(`    if (typeof path !== 'string' && typeof base64 !== 'string') continue;`);
parts.push(`    out.push({`);
parts.push(`      field,`);
parts.push(`      path: typeof path === 'string' ? path : undefined,`);
parts.push(`      base64: typeof base64 === 'string' ? base64 : undefined,`);
parts.push(`      filename: typeof filename === 'string' ? filename : undefined,`);
parts.push(`    });`);
parts.push(`  }`);
parts.push(`  return out;`);
parts.push(`}`);
parts.push(``);
parts.push(`/**`);
parts.push(` * Query values must be scalars. A composite reaching this point would otherwise`);
parts.push(` * be stringified as "[object Object]" and silently filter on nothing.`);
parts.push(` */`);
parts.push(`function pickQuery<T extends Record<string, unknown>>(`);
parts.push(`  source: T,`);
parts.push(`  keys: string[],`);
parts.push(`  csvKeys: string[] = [],`);
parts.push(`): Query {`);
parts.push(`  const out: Query = {};`);
parts.push(`  for (const key of keys) {`);
parts.push(`    const value = (source as Record<string, unknown>)[key];`);
parts.push(`    if (value === undefined) continue;`);
parts.push(`    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {`);
parts.push(`      out[key] = value;`);
parts.push(`    } else if (Array.isArray(value)) {`);
parts.push(`      out[key] = csvKeys.includes(key)`);
parts.push(`        ? value.map((v) => String(v)).join(',')`);
parts.push(`        : value.map((v) => String(v));`);
parts.push(`    } else {`);
parts.push(`      out[key] = JSON.stringify(value);`);
parts.push(`    }`);
parts.push(`  }`);
parts.push(`  return out;`);
parts.push(`}`);
parts.push(``);

for (const [domain, sources] of [...byDomain.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  parts.push(`// ${'='.repeat(72)}`);
  parts.push(`// ${domain}`);
  parts.push(`// ${'='.repeat(72)}`);
  parts.push(``);
  parts.push(sources.join('\n\n'));
  parts.push(``);
}

parts.push(`export interface GeneratedTool {`);
parts.push(`  name: string;`);
parts.push(`  domain: string;`);
parts.push(`  description: string;`);
parts.push(`  inputSchema: z.ZodTypeAny;`);
parts.push(`  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };`);
parts.push(`  /** Spends ElevenLabs credits when called. */`);
parts.push(`  costsCredits: boolean;`);
parts.push(`  /** Marked deprecated in the upstream spec. */`);
parts.push(`  deprecated: boolean;`);
parts.push(`  handler: (client: ElevenLabsClient, args: never) => Promise<unknown>;`);
parts.push(`}`);
parts.push(``);
parts.push(`export const generatedTools: GeneratedTool[] = [`);
for (const r of registry) {
  parts.push(`  {`);
  parts.push(`    name: ${JSON.stringify(r.name)},`);
  parts.push(`    domain: ${JSON.stringify(r.domain)},`);
  parts.push(`    description: ${JSON.stringify(r.description)},`);
  parts.push(`    inputSchema: ${r.input},`);
  parts.push(`    annotations: ${JSON.stringify(r.annotations)},`);
  parts.push(`    costsCredits: ${r.costsCredits},`);
  parts.push(`    deprecated: ${r.deprecated},`);
  parts.push(`    handler: ${r.fn} as unknown as GeneratedTool['handler'],`);
  parts.push(`  },`);
}
parts.push(`];`);
parts.push(``);

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, parts.join('\n'));
console.log(
  `${OUT_PATH}: ${registry.length} tools, ${byDomain.size} domains, ${missing} missing from spec`,
);
