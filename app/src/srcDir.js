import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dirname of the calling module's source directory (app/src/*), robust to
// bundlers: Netlify Functions compiles this tree to CJS, where
// `import.meta.url` is undefined and a bare fileURLToPath would throw at
// import time (entire function 502s). Locally (real ESM) behavior is
// byte-identical to path.dirname(fileURLToPath(import.meta.url)).
// Lambda fallback: probe the filesystem instead of assuming one layout —
// esbuild emits ONE file at <root>/netlify/functions/api.js (CJS __dirname
// = .../netlify/functions, src two levels up), while nft keeps the src/
// layout (CJS __dirname = .../src, beside server.js).
// NOTE: the CJS `__dirname` is referenced only behind a `typeof` guard so
// native ESM (where it does not exist) never throws. Never declare a local
// named `__dirname` anywhere in this tree: esbuild's CJS output already
// defines one and a redeclaration 502s the whole function.
export function srcDir(metaUrl) {
  try {
    const p = metaUrl && fileURLToPath(metaUrl);
    if (p) return path.dirname(p);
  } catch {
    /* bundled CJS — fall through to the layout fallback below */
  }
  const cjsDir = typeof __dirname !== 'undefined' ? __dirname : null;
  const candidates = [
    cjsDir ? path.join(cjsDir, '..', '..', 'src') : null,
    cjsDir,
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, 'src') : null,
    path.join(process.cwd(), 'src'),
    path.join(process.cwd(), 'app', 'src'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'server.js'))) return path.normalize(c);
    } catch { /* keep probing */ }
  }
  return cjsDir || process.cwd();
}

// True on Netlify Functions / any AWS Lambda runtime. The deployed
// filesystem is read-only except /tmp — persistent-file fallbacks must
// live there (the Netlify UI sets explicit DD_* paths per DEPLOY-RUNBOOK,
// this only keeps a missing-var deploy from crashing on first write).
export const isLambda = () =>
  !!(process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

// Writable default for a persistent file: /tmp on Lambda, repo-relative locally.
export const lambdaTmpOr = (name, localPath) =>
  isLambda() ? path.join('/tmp', name) : localPath;
