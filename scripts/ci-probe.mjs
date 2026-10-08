// TEMPORARY diagnostic (branch phase-7-tests only, removed before merge).
// The CI logs are not readable from the review tooling, but Vercel build logs are. This runs the same gates
// CI runs and prints their output so failures can be diagnosed. It never fails the build itself.
import { spawnSync } from 'node:child_process';

const run = (name, cmd, args, tail) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CI: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  console.log(`=== PROBE ${name} exit=${r.status} ===`);
  console.log(out.length > tail ? out.slice(-tail) : out);
  console.log(`=== END PROBE ${name} ===`);
};

run('typecheck', 'npx', ['tsc', '--noEmit'], 3000);
run('lint', 'npx', ['eslint'], 4000);
run('test', 'npx', ['vitest', 'run', '--reporter=default'], 16000);
