import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dirname of the calling module's source directory (app/src/*), robust to
// bundlers: Netlify Functions compiles this tree to CJS, where
// `import.meta.url` is undefined and a bare fileURLToPath would throw at
// import time (entire function 502s). Locally (real ESM) behavior is
// byte-identical to path.dirname(fileURLToPath(import.meta.url)).
// Lambda fallback: the bundle runs at <root>/app/netlify/functions/, so the
// source tree is two levels up + src (included_files ships src/** there).
export function srcDir(metaUrl) {
  try {
    const p = metaUrl && fileURLToPath(metaUrl);
    if (p) return path.dirname(p);
  } catch {
    /* bundled CJS — fall through to the layout fallback below */
  }
  const fnDir = process.env.LAMBDA_TASK_ROOT
    ? path.join(process.env.LAMBDA_TASK_ROOT, 'app', 'netlify', 'functions')
    : process.cwd();
  return path.join(fnDir, '..', '..', 'src');
}
