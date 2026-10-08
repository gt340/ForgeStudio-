// TEMPORARY diagnostic (branch phase-7-tests only, removed before merge).
// The CI logs are not readable from the review tooling, but Vercel build logs are. This runs the same gates
// CI runs and prints compact summaries so failures can be diagnosed. It never fails the build itself.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sh = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CI: '1' }, maxBuffer: 128 * 1024 * 1024 });
const head = (name, r) => console.log(`=== PROBE ${name} exit=${r.status} ===`);
const tailOf = (s, n) => (s.length > n ? s.slice(-n) : s);

// typecheck
let r = sh('npx', ['tsc', '--noEmit']);
head('typecheck', r);
console.log(tailOf(`${r.stdout}\n${r.stderr}`, 2500));

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
      if (byRule[key].ex.length < 3) byRule[key].ex.push(`${f.filePath.replace(process.cwd(), '')}:${m.line} ${String(m.message).slice(0, 90)}`);
    }
  }
  console.log(`lint totals: errors=${errors} warnings=${warnings}`);
  for (const [k, v] of Object.entries(byRule).sort((a, b) => (a[0].startsWith('ERR') ? -1 : 1) - (b[0].startsWith('ERR') ? -1 : 1))) {
    console.log(`${k} x${v.n}`);
    if (k.startsWith('ERR')) v.ex.forEach((e) => console.log(`    ${e}`));
  }
} catch {
  console.log(tailOf(`${r.stdout}\n${r.stderr}`, 3000));
}

// tests (json -> failures only)
r = sh('npx', ['vitest', 'run', '--reporter=json', '--outputFile=.vitest-result.json']);
head('test', r);
try {
  const j = JSON.parse(readFileSync('.vitest-result.json', 'utf8'));
  console.log(`tests: total=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} suites=${j.numTotalTestSuites} failedSuites=${j.numFailedTestSuites}`);
  for (const f of j.testResults) {
    const file = f.name.replace(process.cwd(), '');
    if (f.status === 'failed' && f.assertionResults.every((a) => a.status !== 'failed')) {
      console.log(`SUITE FAILED ${file}: ${String(f.message).slice(0, 700)}`);
    }
    for (const a of f.assertionResults) {
      if (a.status === 'failed') console.log(`FAIL ${file} :: ${a.fullName}\n    ${String(a.failureMessages[0] || '').slice(0, 520).replace(/\n/g, '\n    ')}`);
    }
  }
} catch {
  console.log(tailOf(`${r.stdout}\n${r.stderr}`, 5000));
}
