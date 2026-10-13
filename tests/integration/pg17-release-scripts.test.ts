import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

// PHASE 7B PRODUCTION SCRIPTS, validated on a DISPOSABLE PostgreSQL 17.6 container (never production).
//
// The eight scripts in supabase/pending/phase-7b-release/ are executed EXACTLY as committed: no adaptation, the real
// PostgreSQL 17 version guard (server_version_num 170000..179999) and the PG17 MAINTAIN privilege letter ("m") stay in place.
// Each script is delivered as ONE simple-query string (psql -c "<whole file>"), the same shape as an MCP execute_sql /
// apply_migration call. LIMITATION: the real production path (Supabase MCP / pg-meta wrapper, pooler, role switching) cannot
// be exercised in CI; this test proves the SQL, not the transport.
//
// Needs Docker: runs in CI (CI=true) or with RUN_DB_GATES=1, skipped otherwise. Evidence goes out as ::notice annotations.

const enabled = Boolean(process.env.CI || process.env.RUN_DB_GATES);
const ROOT = process.cwd();
const DIR = 'supabase/pending/phase-7b-release';
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const script = (name: string) => read(`${DIR}/${name}`);

const PG = 'forge-pg17-scripts';
const PG_PORT = 55433;

type Res = { code: number; out: string; err: string; ms: number };
function sh(cmd: string, args: string[], input?: string, timeoutMs = 240_000): Res {
  const t = Date.now();
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error) : ''), ms: Date.now() - t };
}
// whole text as ONE simple-query string via -c (single request, begin/commit inside the text are honoured)
function runC(user: string, sql: string): Res {
  return sh('docker', ['exec', PG, 'psql', '-U', user, '-d', 'app', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}
function runStdin(user: string, db: string, sql: string): Res {
  return sh('docker', ['exec', '-i', PG, 'psql', '-U', user, '-d', db, '-X', '-At', '-v', 'ON_ERROR_STOP=1'], sql);
}
const q = (sql: string, user = 'postgres') => {
  const r = runC(user, sql);
  if (r.code !== 0) throw new Error(`SQL failed: ${r.err}\n${sql.slice(0, 300)}`);
  return r.out.trim();
};

const STATE_SQL = [
  "select 'T|'||c.relname||'|'||coalesce((select string_agg(x::text, ',' order by x::text) from unnest(c.relacl) x),'NULL')||'|rls='||c.relrowsecurity from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by c.relname",
  "select 'D|'||coalesce((select string_agg(x::text, ',' order by x::text) from unnest(d.defaclacl) x),'NULL') from pg_default_acl d where d.defaclrole='postgres'::regrole and d.defaclnamespace='public'::regnamespace and d.defaclobjtype='r'",
  "select 'F|'||coalesce(p.proacl::text,'NULL') from pg_proc p where p.proname='rls_auto_enable'",
  "select 'C|'||(select count(*) from public.forgestudio_projects)||','||(select count(*) from public.forgestudio_project_versions)||','||(select count(*) from public.integrations)||','||(select count(*) from public.seo_settings)||','||(select count(*) from public.env_vars)||' policies='||(select count(*) from pg_policies where schemaname='public')||' fp='||(select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\\n' order by tablename, policyname)) from pg_policies where schemaname='public')",
  "select 'X|probe tables='||(select count(*) from pg_class where relname='_rls_gate_probe')",
].join(';\n');
const state = () => q(STATE_SQL);
const noF = (s: string) => s.split('\n').filter((l) => !l.startsWith('F|')).join('\n');

// rows of the read-only check scripts: n|check|expected|actual|RESULT
const rows = (out: string) => out.split('\n').filter((l) => /\|(PASS|FAIL|INFO)$/.test(l));
const failRows = (out: string) => rows(out).filter((l) => l.endsWith('|FAIL')).map((l) => l.split('|')[0]);
const passCount = (out: string) => rows(out).filter((l) => l.endsWith('|PASS')).length;

const EV: string[] = [];
const ev = (s: string) => EV.push(s);
function emit(title: string, message: string) {
  console.log(`::notice title=${title}::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A').slice(0, 6000)}`);
}

describe.skipIf(!enabled)('Phase 7B production scripts on PostgreSQL 17.6 (disposable container, scripts unadapted)', { timeout: 300_000 }, () => {
  let s0 = '';
  let sPost1 = ''; // state right after Change 1 (set by S4b)

  beforeAll(() => {
    sh('docker', ['rm', '-f', PG]);
    let image = 'postgres:17.6';
    let run = sh('docker', ['run', '-d', '--name', PG, '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_PASSWORD=gatepw', '-p', `${PG_PORT}:5432`, image]);
    if (run.code !== 0) {
      image = 'postgres:17';
      run = sh('docker', ['run', '-d', '--name', PG, '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_PASSWORD=gatepw', '-p', `${PG_PORT}:5432`, image]);
    }
    if (run.code !== 0) throw new Error(`cannot start postgres container: ${run.err}`);
    ev(`image=${image}`);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      const logs = sh('docker', ['logs', PG]);
      const n = (logs.out + logs.err).split('database system is ready to accept connections').length - 1;
      ready = n >= 2 && runStdin('supabase_admin', 'postgres', 'select 1').code === 0;
      if (!ready) sh('sleep', ['1']);
    }
    if (!ready) throw new Error('postgres container did not become ready');
    const pre = runStdin('supabase_admin', 'postgres', 'create role postgres login createrole createdb bypassrls; create database app owner postgres;');
    if (pre.code !== 0) throw new Error(pre.err);
    const setup = runStdin('supabase_admin', 'app', read('supabase/tests/pg17_replica_setup.sql'));
    if (setup.code !== 0) throw new Error(`replica setup failed: ${setup.err}`);
    // stand-ins for what production has and the scripts read: migration history table and realistic (non-empty) data
    const seedA = runStdin(
      'supabase_admin',
      'app',
      `create schema if not exists supabase_migrations;
       create table if not exists supabase_migrations.schema_migrations (version text primary key, name text);
       insert into supabase_migrations.schema_migrations values ('20261008085611','grant_delete_forgestudio_projects_to_authenticated');
       grant usage on schema supabase_migrations to postgres;
       grant select on supabase_migrations.schema_migrations to postgres;
       insert into auth.users (id,email) values ('00000000-0000-0000-0000-0000000000a1','a@example.test'),('00000000-0000-0000-0000-0000000000b1','b@example.test');`,
    );
    if (seedA.code !== 0) throw new Error(`seed A failed: ${seedA.err}`);
    const seedB = runStdin(
      'postgres',
      'app',
      `insert into public.forgestudio_projects (id,user_id,prompt,code) values
        ('11111111-0000-4000-8000-000000000001','00000000-0000-0000-0000-0000000000a1','p1','c'),
        ('11111111-0000-4000-8000-000000000002','00000000-0000-0000-0000-0000000000a1','p2','c'),
        ('11111111-0000-4000-8000-000000000003','00000000-0000-0000-0000-0000000000b1','p3','c');
       insert into public.forgestudio_project_versions (project_id,user_id,version_number,code) values ('11111111-0000-4000-8000-000000000001','00000000-0000-0000-0000-0000000000a1',1,'v');
       insert into public.integrations (provider,user_id) values ('github','00000000-0000-0000-0000-0000000000a1');
       insert into public.seo_settings (user_id) values ('00000000-0000-0000-0000-0000000000b1');
       insert into public.env_vars (key,value,user_id) values ('K','V','00000000-0000-0000-0000-0000000000a1');`,
    );
    if (seedB.code !== 0) throw new Error(`seed B failed: ${seedB.err}`);
    s0 = state();
  }, 600_000);

  afterAll(() => {
    // short annotations (<= ~1300 chars each, at most 4): very long messages were not displayed for the older gates test
    const chunks: string[] = [];
    let cur = '';
    for (const line of EV) {
      if (cur.length + line.length + 1 > 1300 && cur) {
        chunks.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + line.slice(0, 600);
    }
    if (cur) chunks.push(cur);
    chunks.slice(0, 4).forEach((c, i) => emit(`pg17-scripts-${i + 1}`, c));
    // full evidence also goes to the job summary (no size/count cap, unlike annotations)
    try {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### pg17-scripts evidence (PostgreSQL 17.6, scripts unadapted)\n\n\`\`\`\n${EV.join('\n')}\n\`\`\`\n`);
    } catch {
      /* summary is best effort */
    }
    sh('docker', ['rm', '-f', PG]);
  });

  it('S0: scripts are unadapted (real PG17 guard and MAINTAIN letter present) and the server is PostgreSQL 17.x', () => {
    const files = ['01_preflight_readonly.sql', '02_change1_least_privilege.sql', '03_verify_change1_readonly.sql', '04_verify_behavior_readonly.sql', '05_rollback_change1.sql', '06_change2_rls_auto_enable.sql', '07_verify_change2_readonly.sql', '08_rollback_change2.sql'];
    for (const f of files) {
      const s = script(f);
      ev(`sha256 ${f} ${createHash('sha256').update(s).digest('hex').slice(0, 16)} (${s.length} bytes)`);
      expect(s, f).not.toMatch(/160000|169999/); // no PG16 adaptation
    }
    for (const f of ['02_change1_least_privilege.sql', '05_rollback_change1.sql', '06_change2_rls_auto_enable.sql']) {
      const s = script(f);
      expect(s, f).toContain('170000');
      expect(s, f).toContain('179999');
    }
    expect(script('02_change1_least_privilege.sql')).toContain('arwdDxtm');
    expect(script('01_preflight_readonly.sql')).toContain('arwdDxtm');
    expect(script('01_preflight_readonly.sql')).toContain('MAINTAIN');
    const v = q('show server_version');
    ev(`server_version=${v} MAINTAIN recognised=${q("select has_table_privilege('postgres','public.env_vars'::regclass,'MAINTAIN')")}`);
    expect(v.startsWith('17.')).toBe(true);
  });

  it('S1: 01 preflight on the replica of production: zero FAIL rows', () => {
    const r = runC('postgres', script('01_preflight_readonly.sql'));
    expect(r.code, r.err).toBe(0);
    ev(`01 preflight: ${passCount(r.out)} PASS, FAIL rows=[${failRows(r.out).join(',')}], total rows=${rows(r.out).length}`);
    expect(failRows(r.out)).toEqual([]);
    expect(passCount(r.out)).toBeGreaterThanOrEqual(15);
  });

  it('S2: drift is rejected by Change 1 and nothing changes', () => {
    q('revoke delete on public.env_vars from authenticated');
    const before = state();
    const r = runC('postgres', script('02_change1_least_privilege.sql'));
    const after = state();
    ev(`drift: exit=${r.code} msg=${(r.err.match(/PREFLIGHT:[^\n]*/) ?? [''])[0].slice(0, 160)} state unchanged=${before === after}`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('PREFLIGHT: ACL of public.env_vars');
    expect(after).toBe(before);
    q('grant delete on public.env_vars to authenticated');
    expect(state()).toBe(s0);
  });

  it('S3: a failing POSTCHECK rolls the whole of Change 1 back', () => {
    const s = script('02_change1_least_privilege.sql');
    const a = s.indexOf('revoke all privileges on table');
    const b = s.indexOf('from anon;', a) + 'from anon;'.length;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const mutant = s.slice(0, a) + '-- omitted' + s.slice(b);
    const r = runC('postgres', mutant);
    const after = state();
    ev(`postcheck mutant (Change 1 without the revoke-all): exit=${r.code} msg=${(r.err.match(/POSTCHECK:[^\n]*/) ?? [''])[0].slice(0, 160)} state unchanged=${after === s0}`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('POSTCHECK: ACL of public.env_vars');
    expect(after).toBe(s0);
  });

  it('S3b: Change 2 is rejected on the original baseline (change-order gate) and nothing changes', () => {
    expect(state()).toBe(s0);
    const r = runC('postgres', script('06_change2_rls_auto_enable.sql'));
    ev(`change2 on baseline: exit=${r.code} msg=${(r.err.match(/PREFLIGHT:[^\n]*/) ?? [''])[0].slice(0, 140)} state unchanged=${state() === s0}`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('PREFLIGHT: Change 1 is not in place');
    expect(state()).toBe(s0);
    expect(q("select coalesce(proacl::text,'NULL') from pg_proc where proname='rls_auto_enable'")).toBe('NULL');
  });

  it('S4: Change 1 (exact script) applies, verifies, and cannot be run twice', () => {
    const r = runC('postgres', script('02_change1_least_privilege.sql'));
    expect(r.code, r.err).toBe(0);
    const s1 = state();
    expect(s1).not.toBe(s0);
    const v3 = runC('postgres', script('03_verify_change1_readonly.sql'));
    expect(v3.code, v3.err).toBe(0);
    ev(`Change 1 applied. 03 verify: ${passCount(v3.out)} PASS, FAIL rows=[${failRows(v3.out).join(',')}]`);
    expect(failRows(v3.out)).toEqual([]);
    expect(passCount(v3.out)).toBeGreaterThanOrEqual(18);
    const v4 = runC('postgres', script('04_verify_behavior_readonly.sql'));
    ev(`04 behaviour: ${(v4.err.match(/RESULT:[^\n]*/) ?? ['(no RESULT line)'])[0]}`);
    expect(v4.err).toContain('anon_denied=5/5 auth_rls_filtered=5/5 owner_sees_own_rows=true');
    expect(state()).toBe(s1);
    const again = runC('postgres', script('02_change1_least_privilege.sql'));
    ev(`repeat-run of Change 1: exit=${again.code} msg=${(again.err.match(/PREFLIGHT:[^\n]*/) ?? [''])[0].slice(0, 120)}`);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain('PREFLIGHT: ACL of public');
    expect(state()).toBe(s1);
  });

  it('S4b: Change 2 gate rejects partial, drifted and over-revoked Change 1 states; a Change 2 mutant that touches table ACLs is rolled back', () => {
    sPost1 = state();
    expect(sPost1).not.toBe(s0);
    const s = script('06_change2_rls_auto_enable.sql');
    const cases: { name: string; apply: string; revert: string; msg: string }[] = [
      { name: 'partial: anon SELECT left on env_vars', apply: 'grant select on public.env_vars to anon', revert: 'revoke select on public.env_vars from anon', msg: 'ACL of public.env_vars' },
      { name: 'partial: TRUNCATE left on seo_settings for authenticated', apply: 'grant truncate on public.seo_settings to authenticated', revert: 'revoke truncate on public.seo_settings from authenticated', msg: 'ACL of public.seo_settings' },
      { name: 'partial: default ACL still hands TRUNCATE to anon', apply: 'alter default privileges for role postgres in schema public grant truncate on tables to anon', revert: 'alter default privileges for role postgres in schema public revoke truncate on tables from anon', msg: 'default ACL (postgres, public, tables)' },
      { name: 'over-revoked: authenticated lost SELECT on integrations', apply: 'revoke select on public.integrations from authenticated', revert: 'grant select on public.integrations to authenticated', msg: 'ACL of public.integrations' },
      { name: 'over-revoked: authenticated lost DELETE on forgestudio_project_versions', apply: 'revoke delete on public.forgestudio_project_versions from authenticated', revert: 'grant delete on public.forgestudio_project_versions to authenticated', msg: 'ACL of public.forgestudio_project_versions' },
    ];
    for (const c of cases) {
      q(c.apply);
      const before = state();
      const r = runC('postgres', s);
      const after = state();
      ev(`gate ${c.name}: exit=${r.code} msg=${(r.err.match(/PREFLIGHT:[^\n]*/) ?? [''])[0].slice(0, 120)} state unchanged=${after === before}`);
      expect(r.code, c.name).not.toBe(0);
      expect(r.err, c.name).toContain('PREFLIGHT: Change 1 is not in place');
      expect(r.err, c.name).toContain(c.msg);
      expect(after, c.name).toBe(before);
      q(c.revert);
      expect(state(), `${c.name} revert`).toBe(sPost1);
    }
    // the new POSTCHECK: a Change 2 that also alters a table ACL must roll back completely
    const stmt = 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated;';
    expect(s).toContain(stmt);
    const mutant = s.replace(stmt, `${stmt}\ngrant select on public.env_vars to anon;`);
    const m = runC('postgres', mutant);
    ev(`change2 mutant altering a table ACL: exit=${m.code} msg=${(m.err.match(/POSTCHECK:[^\n]*/) ?? [''])[0].slice(0, 120)} state unchanged=${state() === sPost1}`);
    expect(m.code).not.toBe(0);
    expect(m.err).toContain('POSTCHECK: row counts / RLS flags / policies / table ACLs changed');
    expect(state()).toBe(sPost1);
  });

  it('S5: Change 2 POSTCHECK failure rolls back; real Change 2 applies and verifies', () => {
    const s = script('06_change2_rls_auto_enable.sql');
    const stmt = 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated;';
    expect(s).toContain(stmt);
    const before = state();
    const bad = runC('postgres', s.replace(stmt, '-- omitted'));
    ev(`change2 mutant (without the revoke): exit=${bad.code} msg=${(bad.err.match(/POSTCHECK:[^\n]*/) ?? [''])[0].slice(0, 120)} state unchanged=${state() === before}`);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('POSTCHECK: proacl is');
    expect(state()).toBe(before);
    const r = runC('postgres', s);
    expect(r.code, r.err).toBe(0);
    const v7 = runC('postgres', script('07_verify_change2_readonly.sql'));
    expect(v7.code, v7.err).toBe(0);
    ev(`Change 2 applied. 07 verify: ${passCount(v7.out)} PASS, FAIL rows=[${failRows(v7.out).join(',')}]; ${q("select 'X|probe tables='||count(*) from pg_class where relname='_rls_gate_probe'")}`);
    expect(failRows(v7.out)).toEqual([]);
    expect(state()).toContain('X|probe tables=0');
  });

  it('S5b: Change 2 left the table ACLs unchanged, and a repeat run is rejected', () => {
    expect(noF(state())).toBe(noF(sPost1));
    const before = state();
    const again = runC('postgres', script('06_change2_rls_auto_enable.sql'));
    ev(`repeat-run of Change 2: exit=${again.code} msg=${(again.err.match(/PREFLIGHT:[^\n]*/) ?? [''])[0].slice(0, 120)}`);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain('PREFLIGHT: proacl is');
    expect(again.err).not.toContain('Change 1 is not in place'); // the gate passes; the existing precheck refuses the repeat
    expect(state()).toBe(before);
  });

  it('S6: both rollbacks restore the baseline and refuse to run when the change is not in place', () => {
    const r1 = runC('postgres', script('05_rollback_change1.sql'));
    expect(r1.code, r1.err).toBe(0);
    const rb1 = state();
    ev(`rollback 1: table ACLs, default ACL, RLS flags, counts, policy fingerprint identical to baseline (excluding function proacl text) = ${noF(rb1) === noF(s0)}`);
    expect(noF(rb1)).toBe(noF(s0));
    const r1b = runC('postgres', script('05_rollback_change1.sql'));
    expect(r1b.code).not.toBe(0);
    expect(r1b.err).toContain('ROLLBACK-PRECHECK');
    const r2 = runC('postgres', script('08_rollback_change2.sql'));
    expect(r2.code, r2.err).toBe(0);
    const r2b = runC('postgres', script('08_rollback_change2.sql'));
    expect(r2b.code).not.toBe(0);
    expect(r2b.err).toContain('ROLLBACK-PRECHECK');
    const pf = runC('postgres', script('01_preflight_readonly.sql'));
    ev(`preflight after both rollbacks: FAIL rows=[${failRows(pf.out).join(',')}] proacl now=${q("select coalesce(proacl::text,'NULL') from pg_proc where proname='rls_auto_enable'")} (baseline NULL; functionally identical)`);
    expect(noF(state())).toBe(noF(s0));
    // only the proacl-text row may differ from the original baseline
    expect(failRows(pf.out).length).toBeLessThanOrEqual(1);
  });

  it('S6b: after the rollbacks (baseline ACLs) Change 2 is rejected again by the gate', () => {
    const before = state();
    expect(noF(before)).toBe(noF(s0));
    const r = runC('postgres', script('06_change2_rls_auto_enable.sql'));
    ev(`change2 after rollbacks: exit=${r.code} msg=${(r.err.match(/PREFLIGHT:[^\n]*/) ?? [''])[0].slice(0, 120)}`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('PREFLIGHT: Change 1 is not in place');
    expect(state()).toBe(before);
  });

  it('S7: re-apply after rollback works (Change 1 then Change 2)', () => {
    const a = runC('postgres', script('02_change1_least_privilege.sql'));
    expect(a.code, a.err).toBe(0);
    const b = runC('postgres', script('06_change2_rls_auto_enable.sql'));
    expect(b.code, b.err).toBe(0);
    ev('re-apply after rollback: Change 1 and Change 2 both succeeded');
  });

  it('S8: lock_timeout makes Change 1 fail fast behind a conflicting lock and changes nothing', () => {
    expect(runC('postgres', script('05_rollback_change1.sql')).code).toBe(0);
    const pre = state();
    const holder = spawn('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', 'app', '-X', '-q', '-c', 'begin; lock table public.env_vars in access exclusive mode; select pg_sleep(40); commit;'], { stdio: 'ignore' });
    let locked = false;
    for (let i = 0; i < 20 && !locked; i++) {
      sh('sleep', ['1']);
      locked = q("select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='env_vars' and l.mode='AccessExclusiveLock' and l.granted", 'supabase_admin') !== '0';
    }
    expect(locked).toBe(true);
    const r = runC('postgres', script('02_change1_least_privilege.sql'));
    q("select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(40)%' and pid <> pg_backend_pid()", 'supabase_admin');
    holder.kill();
    ev(`lock timeout: exit=${r.code} after ${Math.round(r.ms / 1000)}s msg=${(r.err.match(/[^\n]*lock timeout[^\n]*/i) ?? [''])[0].slice(0, 120)}`);
    expect(r.code).not.toBe(0);
    expect(r.err.toLowerCase()).toContain('lock timeout');
    expect(r.ms).toBeLessThan(20_000);
    sh('sleep', ['1']);
    expect(state()).toBe(pre);
  });
});
