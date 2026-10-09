// T6 log hygiene — static allowlist over every console.* call in app/src.
// Server-runtime files: single-line, no blob/fact text, no userIds beyond
// short sliced prefixes, no stacks/paths/secrets. CLI entry scripts (eval,
// seed*, stats, verify, telegram) and test runners (selftest, wallet.test)
// keep console output as their product, but are still scanned for
// stacks/secrets/paths. *.test.js files are not scanned (assertions, not logs).
// Run: node --test src/loghygiene.test.js   (part of `npm test`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = new URL('.', import.meta.url).pathname;
const RUNTIME = new Set([
  'server.js', 'memory.js', 'usage.js', 'db.js', 'walletAuth.js', 'onboarding.js',
  'rateLimit.js', 'cryptoUtils.js', 'localClient.js', 'userRegistry.js',
  'page.js', 'guardBody.js', 'onchain.js',
]);
const CLI = new Set(['eval.js', 'seed10.js', 'seed-demo.js', 'stats.js', 'verify.js', 'telegram.js']);
const RUNNERS = new Set(['selftest.js', 'wallet.test.js']);

// console.log in runtime files: allowlisted lines only (progress/boot, ids sliced).
const LOG_ALLOW = [
  /\[nudge\] \$\{String\(u\)\.slice\(0, 10\)\}/, // sliced id prefix only
  /Mediara on :\$\{port\}/,
  /shutting down/,
];
function consoleLines(file) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  return src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /console\.(log|error|warn)\(/.test(line) && !line.trim().startsWith('//'));
}

test('log hygiene: runtime files keep console.log to the allowlist', () => {
  const violations = [];
  for (const f of RUNTIME) {
    for (const { line, n } of consoleLines(f)) {
      if (!/console\.log\(/.test(line)) continue;
      if (!LOG_ALLOW.some((re) => re.test(line))) violations.push(`${f}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `non-allowlisted console.log in runtime files:\n${violations.join('\n')}`);
});

test('log hygiene: every runtime console call is bounded or static (no raw error/user text)', () => {
  // A runtime console call is compliant when it is EITHER a bounded single-line
  // print (`.slice(0, N)` on every interpolated value) OR a static string with
  // no interpolated values at all (boot/shutdown/config notices). Anything
  // else — an unbounded error object, a full user id, a fact/blob variable —
  // fails here. Catches comma-arg forms too, not just `${}` interpolations.
  const STATIC_OK = [
    /write skipped: fact truncated past its safety signal/,
    /shutting down/,
  ];
  // Interpolations that carry no user/fact/secret text (ports, config echoes,
  // deterministic kind labels, numeric failure counters) — everything else
  // needs a `.slice(0, N)` bound.
  const SCALAR_OK = [/^port$/, /^tp$/, /tick\.items/, /^BREAKER\.fails$/];
  const violations = [];
  const interpsOf = (line) => {
    const out = [];
    const re = /\$\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1]);
    return out;
  };
  for (const f of RUNTIME) {
    for (const { line, n } of consoleLines(f)) {
      let bad = false;
      for (const interp of interpsOf(line)) {
        if (/slice\(0,/.test(interp)) continue;
        if (SCALAR_OK.some((re) => re.test(interp))) continue;
        violations.push(`${f}:${n}: unbounded interpolation \${${interp}}: ${line.trim()}`);
        bad = true;
      }
      if (bad) continue;
      if (!/\$\{/.test(line) && !/slice\(0,/.test(line) && !STATIC_OK.some((re) => re.test(line))) {
        // Comma-arg form: strip string literals, then look for raw values.
        const code = line.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
        if (/(String\(|e\.message|\berr\b|\bmessage\b|\bfact\b|\bblob\b|\buserId\b|\baddress\b)/.test(code)) {
          violations.push(`${f}:${n}: unbounded console arg: ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `unbounded runtime logs:\n${violations.join('\n')}`);
});

test('log hygiene: no stacks, paths, or secrets in any console call', () => {
  const violations = [];
  const files = [...RUNTIME, ...CLI, ...RUNNERS];
  for (const f of files) {
    for (const { line, n } of consoleLines(f)) {
      if (/\.stack\b/.test(line)) violations.push(`${f}:${n}: stack in log: ${line.trim()}`);
      if (/process\.env\.[A-Z_]* ?(SECRET|KEY|TOKEN)/.test(line)) violations.push(`${f}:${n}: secret env in log: ${line.trim()}`);
      if (/storePath\(\)|__dirname|persistPath/.test(line)) violations.push(`${f}:${n}: filesystem path in log: ${line.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `stack/path/secret in logs:\n${violations.join('\n')}`);
});

test('log hygiene: runtime console calls are single-line (no multi-line blob prints)', () => {
  const violations = [];
  for (const f of RUNTIME) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    // A console call spanning a newline risks dumping objects/blobs raw.
    const re = /console\.(log|error|warn)\(([^;]*?)\);/gs;
    let m;
    while ((m = re.exec(src))) {
      const call = m[0];
      if (/\n/.test(call) && !/slice\(0,/.test(call)) {
        const lineNo = src.slice(0, m.index).split('\n').length;
        violations.push(`${f}:${lineNo}: multi-line console call: ${call.split('\n')[0].trim()}…`);
      }
    }
  }
  assert.deepEqual(violations, [], `multi-line console calls in runtime files:\n${violations.join('\n')}`);
});
