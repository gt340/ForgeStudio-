import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 7B: Change 2 (script 06) must refuse to run unless Change 1 (script 02) is in place. The gate in 06 repeats the
// expected post-Change-1 ACL values that script 02 asserts in its POSTCHECK. These static tests keep the two copies identical
// and keep the gate in front of the only mutating statement. The behaviour itself is proven on PostgreSQL 17.6 in
// tests/integration/pg17-release-scripts.test.ts.
const DIR = join(process.cwd(), 'supabase/pending/phase-7b-release');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const s02 = read('02_change1_least_privilege.sql');
const s06 = read('06_change2_rls_auto_enable.sql');

const TUPLE = /^\s*\('(\w+)', array\[([^\]]*)\]::text\[\]\),?\s*$/gm;
const tuples = (sql: string) => [...sql.matchAll(TUPLE)].map((m) => `${m[1]}=${m[2]}`);
const DEFAULT_ACL = "array['postgres=arwdDxtm/postgres','service_role=Dxtm/postgres']";

describe('Change 2 change-order gate (static)', () => {
  it('06 carries exactly the five post-Change-1 table ACL sets that 02 asserts in its POSTCHECK', () => {
    const t02 = tuples(s02);
    expect(t02).toHaveLength(10); // 5 PREFLIGHT (baseline) + 5 POSTCHECK (post-change)
    const post02 = t02.slice(5);
    const t06 = tuples(s06);
    expect(t06).toHaveLength(5);
    expect(t06).toEqual(post02);
    for (const t of t06) expect(t).not.toMatch(/anon=/);
  });

  it('06 requires the same default table ACL as the POSTCHECK of 02', () => {
    expect(s02.split(DEFAULT_ACL).length - 1).toBeGreaterThanOrEqual(2); // the POSTCHECK compares and reports it
    expect(s06.split(DEFAULT_ACL).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('the gate sits in the preflight, after the PG17 guard and before the only change', () => {
    const guard = s06.indexOf("raise exception 'PREFLIGHT: expected PostgreSQL 17");
    const gate = s06.indexOf("raise exception 'PREFLIGHT: Change 1 is not in place"); // the raise, not the header comment
    const revoke = s06.indexOf('revoke execute on function public.rls_auto_enable()');
    const post = s06.indexOf('do $c2_post$');
    expect(guard).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(guard);
    expect(revoke).toBeGreaterThan(gate);
    expect(post).toBeGreaterThan(revoke);
    // exactly one mutating statement and one revoke
    expect(s06.match(/^\s*(revoke|grant)\b/gim)).toHaveLength(1);
  });

  it('06 keeps its transaction boundary, timeouts, version guard and ACL snapshot comparison', () => {
    expect(s06.match(/^begin;/gm)).toHaveLength(1);
    expect(s06.match(/^commit;/gm)).toHaveLength(1);
    expect(s06).toContain("set local lock_timeout = '5s'");
    expect(s06).toContain("set local statement_timeout = '60s'");
    expect(s06).toContain('170000 and 179999');
    expect(s06.split("'acl', (select string_agg(c.relname").length - 1).toBe(2); // snapshot before and after
    expect(s06).toContain('POSTCHECK: row counts / RLS flags / policies / table ACLs changed');
  });
});
