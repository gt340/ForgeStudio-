import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 7B release gate: the least-privilege migration must stay OUT of supabase/migrations until the Commander
// authorizes applying it to production. Anything under supabase/migrations can be applied by migration tooling or a
// Supabase GitHub integration when merged, so the pending file must live in supabase/pending.
const root = process.cwd();
const PENDING = 'supabase/pending/20261010120000_least_privilege_public_tables.sql';

describe('pending production migration is isolated', () => {
  it('is in supabase/pending and not in supabase/migrations', () => {
    expect(existsSync(join(root, PENDING))).toBe(true);
    const migrations = readdirSync(join(root, 'supabase/migrations'));
    expect(migrations.filter((f) => f.includes('least_privilege'))).toEqual([]);
    expect(migrations.filter((f) => f.startsWith('20261010120000'))).toEqual([]);
  });

  it('is marked pending / not applied in its header', () => {
    const head = readFileSync(join(root, PENDING), 'utf8').slice(0, 800);
    expect(head).toContain('PENDING, NOT APPLIED TO PRODUCTION');
  });

  it('no workflow or package script applies SQL or deploys the database', () => {
    const wfDir = join(root, '.github/workflows');
    const wf = existsSync(wfDir) ? readdirSync(wfDir).map((f) => readFileSync(join(wfDir, f), 'utf8')).join('\n') : '';
    expect(wf).not.toMatch(/supabase\s+(db\s+push|migration\s+up|link)/);
    expect(wf).not.toMatch(/apply_migration|psql[^\n]*supabase\/(pending|migrations)/);
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      expect(cmd, `package.json script ${name}`).not.toMatch(/supabase|psql|migrat/i);
    }
  });
});
