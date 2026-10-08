// TEMPORARY diagnostic (branch phase-7-tests only, removed before merge).
// The CI logs are not readable from the review tooling, but Vercel build logs are. This runs the same gates
// CI runs and prints compact summaries so failures can be diagnosed. It never fails the build itself.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Vercel builds run with NODE_ENV=production, which strips React's test helpers; CI does not.
const sh = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CI: '1', NODE_ENV: 'test' }, maxBuffer: 128 * 1024 * 1024 });
const head = (name, r) => console.log(`=== PROBE ${name} exit=${r.status} ===`);
const tailOf = (s, n) => (s.length > n ? s.slice(-n) : s);
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// typecheck
let r = sh('npx', ['tsc', '--noEmit']);
head('typecheck', r);
console.log(oneLine(tailOf(`${r.stdout}\n${r.stderr}`, 1500), 1500));

// lint (json -> per-rule summary)
r = sh('npx', ['eslint', '-f', 'json']);
head('lint', r);
try {
  const files = JSON.parse(r.stdout);
  const byRule = {};
  let errors = 0;
  let warnings = 0;
  for (const f of files) {
    for (const m of f.messages) {
      const key = `${m.severity === 2 ? 'ERR' : 'warn'} ${m.ruleId || 'parse'}`;
      byRule[key] = byRule[key] || { n: 0, ex: [] };
      byRule[key].n++;
      if (m.severity === 2) errors++;
      else warnings++;
      if (byRule[key].ex.length < 4) byRule[key].ex.push(`${f.filePath.replace(process.cwd(), '')}:${m.line} ${oneLine(m.message, 70)}`);
    }
  }
  console.log(`lint totals: errors=${errors} warnings=${warnings}`);
  for (const [k, v] of Object.entries(byRule)) {
    if (k.startsWith('ERR')) console.log(`${k} x${v.n} :: ${v.ex.join(' || ')}`);
  }
} catch {
  console.log(oneLine(tailOf(`${r.stdout}\n${r.stderr}`, 2500), 2500));
}

// tests (json -> failures only, one line each)
r = sh('npx', ['vitest', 'run', '--reporter=json', '--outputFile=.vitest-result.json']);
head('test', r);
try {
  const j = JSON.parse(readFileSync('.vitest-result.json', 'utf8'));
  console.log(`TESTS total=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} suitesFailed=${j.numFailedTestSuites}/${j.numTotalTestSuites}`);
  let shown = 0;
  for (const f of j.testResults) {
    const file = f.name.replace(process.cwd(), '');
    if (f.status === 'failed' && f.assertionResults.every((a) => a.status !== 'failed')) {
      console.log(`SUITE-FAILED ${file} :: ${oneLine(f.message, 400)}`);
    }
    for (const a of f.assertionResults) {
      if (a.status === 'failed' && shown++ < 30) console.log(`FAIL ${file.replace('/tests/', '')} :: ${oneLine(a.fullName, 90)} => ${oneLine(a.failureMessages[0], 260)}`);
    }
  }
} catch {
  console.log(oneLine(tailOf(`${r.stdout}\n${r.stderr}`, 3000), 3000));
}
console.log('=== END PROBE ===');
