// Walks every parameterless GET in the spec with the API key and reports, per domain,
// which areas the key's scope actually opens. A 401 with status missing_permissions
// names the scope that is absent; anything else is a real answer from the endpoint.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const naming = JSON.parse(readFileSync(new URL('/home/agbergsmann/projects/mcp-server-elevenlabs/spec/elevenlabs-tool-naming.json', import.meta.url)));
const key = execFileSync('pass', ['show', 'api/elevenlabs'], { encoding: 'utf-8' }).split('\n')[0].trim();

const targets = naming.operations.filter(
  (o) => o.method === 'GET' && !o.path.includes('{') && !o.binaryResponse,
);

const byDomain = new Map();
for (const op of targets) {
  const res = await fetch(`https://api.elevenlabs.io${op.path}`, {
    headers: { 'xi-api-key': key, accept: 'application/json' },
  }).catch((e) => ({ status: 0, text: async () => e.message }));
  let missing = null;
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    const m = body.match(/permission ([a-z_]+) to execute/);
    missing = m ? m[1] : 'unknown';
  }
  if (!byDomain.has(op.domain)) byDomain.set(op.domain, []);
  byDomain.get(op.domain).push({ path: op.path, status: res.status, missing });
  await new Promise((r) => setTimeout(r, 120));
}

const open = [], blocked = [], other = [];
for (const [domain, rows] of [...byDomain.entries()].sort()) {
  const ok = rows.filter((r) => r.status === 200).length;
  const denied = rows.filter((r) => r.missing);
  const line = `${domain.padEnd(26)} ${ok}/${rows.length} ok`;
  if (denied.length > 0) blocked.push(`${line}   hiányzó jog: ${[...new Set(denied.map((d) => d.missing))].join(', ')}`);
  else if (ok === rows.length) open.push(line);
  else other.push(`${line}   státuszok: ${[...new Set(rows.map((r) => r.status))].join(', ')}`);
}
console.log(`Megnyitva (${open.length} terület):`);
open.forEach((l) => console.log('  ' + l));
console.log(`\nBlokkolva jogosultság miatt (${blocked.length}):`);
blocked.length ? blocked.forEach((l) => console.log('  ' + l)) : console.log('  nincs');
console.log(`\nEgyéb válasz (${other.length}):`);
other.length ? other.forEach((l) => console.log('  ' + l)) : console.log('  nincs');
console.log(`\nösszesen ${targets.length} végpont, ${[...byDomain.keys()].length} terület`);
