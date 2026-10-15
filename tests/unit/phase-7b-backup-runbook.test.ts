import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static consistency of the Phase 7B backup runbook with the CI test that exercises it. The behaviour is proven on
// PostgreSQL 17.6 in tests/integration/pg17-backup-validation.test.ts; these checks only keep the documents honest.
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const runbook = read('docs/PHASE-7B-BACKUP-RUNBOOK.md');
const test = read('tests/integration/pg17-backup-validation.test.ts');
const readme = read('supabase/pending/phase-7b-release/README.md');

describe('Phase 7B backup runbook (static)', () => {
  it('has every required topic', () => {
    for (const h of [
      '## 1. Scope', '## 2. Tested versions', '## 3. Commands and their status', '## 4. Credentials and shell history', '## 5. Artifact location',
      '## 6. Encryption', '## 7. Checksums', '## 8. Two protected locations', '## 9. Restore', '## 10. Failure response',
      '## 11. What the backup includes and excludes', '## 13. Supabase-specific limitations', '## 14. Authorization',
    ]) expect(runbook, h).toContain(h);
  });

  it('keeps untested commands labeled and never claims production authorization or full disaster recovery', () => {
    expect(runbook).toContain('UNTESTED');
    expect(runbook).toContain('does NOT authorize running anything against production');
    expect(runbook).toContain('do not authorize production execution');
    expect(runbook).toMatch(/Full disaster recovery is \*\*not\*\* claimed/);
    expect(runbook).toContain('PostgreSQL 16');
  });

  it('carries the exact flags the CI test uses', () => {
    for (const f of ['--schema=public', '--format=custom', '--single-transaction', '--symmetric', '--cipher-algo AES256', '--passphrase-fd 0', '--pinentry-mode loopback']) {
      expect(runbook, f).toContain(f);
    }
    expect(test).toContain("'--schema=public', '--format=custom'");
    expect(test).toContain("'--single-transaction'");
  });

  it('documents the schema ACL capture and recovery step that the CI test performs', () => {
    expect(runbook).toContain('schema-acl.txt');
    expect(runbook).toContain('| 12b |');
    expect(test).toContain('schemaAclRecoverySql');
    expect(test).toContain("'schema-acl.txt'");
    expect(test).toMatch(/diffSnap\(srcSnap, after, \['N'\]\)/);
  });

  it('contains no password literal or connection string with a password', () => {
    expect(runbook).not.toMatch(/postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/);
    expect(runbook).not.toMatch(/PGPASSWORD=\S/);
    expect(runbook).not.toMatch(/--password|-W\s/);
  });

  it('uses the pinned image without a fallback in the CI test', () => {
    expect(test).toContain('postgres:17.6');
    expect(test).not.toMatch(/postgres:17['"]/);
    expect(test).not.toMatch(/postgres:16/);
  });

  it('is linked from the Phase 7B README, which keeps the production gate', () => {
    expect(readme).toContain('docs/PHASE-7B-BACKUP-RUNBOOK.md');
    expect(readme).toMatch(/production changes remain blocked/i);
  });
});
