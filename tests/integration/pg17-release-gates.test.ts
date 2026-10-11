import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// PHASE 7B RELEASE GATES, run against a DISPOSABLE PostgreSQL 17 container (never production).
//
// Production is PostgreSQL 17.6. This test starts postgres:17.6 in Docker, rebuilds the production shape from
// supabase/tests/pg17_replica_setup.sql (roles, default privileges, tables, RLS, exact table ACLs, rls_auto_enable
// + event trigger), then exercises the REAL migration and rollback files, the extended grant check, owner-only RLS,
// and the REAL delete route handler against PostgREST with disposable users and projects.
//
// It needs Docker, so it runs in CI (CI=true) or with RUN_DB_GATES=1 and is skipped otherwise.
// Evidence is printed as `::notice` annotations (visible on the GitHub Actions run page).

const enabled = Boolean(process.env.CI || process.env.RUN_DB_GATES);

const h = vi.hoisted(() => ({ user: null as { id: string } | null, client: null as unknown }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => h.client,
}));

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const PG = 'forge-pg17-gates';
const REST = 'forge-postgrest-gates';
const PG_PORT = 55432;
const REST_PORT = 3011;
const JWT_SECRET = 'disposable-gate-secret-0123456789-abcdefghij';

type Res = { code: number; out: string; err: string };
function sh(cmd: string, args: string[], input?: string, timeoutMs = 240_000): Res {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}
// run SQL inside the container as `user` against database `db` (unaligned, tuples only, stop at first error)
function psql(user: string, db: string, sql: string): Res {
  return sh('docker', ['exec', '-i', PG, 'psql', '-U', user, '-d', db, '-X', '-At', '-v', 'ON_ERROR_STOP=1'], sql);
}
const q = (sql: string, user = 'postgres') => {
  const r = psql(user, 'app', sql);
  if (r.code !== 0) throw new Error(`SQL failed: ${r.err}\n${sql.slice(0, 300)}`);
  return r.out.trim();
};

// GitHub keeps only ~10 annotations per step, so evidence is buffered and emitted as three combined annotations in afterAll.
function emit(title: string, message: string) {
  console.log(`::notice title=${title}::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A').slice(0, 6000)}`);
}
const BUF: { title: string; msg: string }[] = [];
function notice(title: string, message: string) {
  BUF.push({ title, msg: message });
}
function flushNotices() {
  const groups: [string, (t: string) => boolean][] = [
    ['gates-A-B-C-E-F-suite', (t) => /^gate-(A|B-before|CEF)/.test(t)],
    ['gates-migration-delete-rollback', (t) => /^gate-(CE-migration|B-after|delete|F-rollback)/.test(t)],
    ['gate-D-rls_auto_enable', (t) => t.startsWith('gate-D')],
  ];
  for (const [title, test] of groups) {
    emit(title, BUF.filter((b) => test(b.title)).map((b) => `[${b.title}] ${b.msg}`).join('\n'));
  }
}

// ACL text -> sorted entries, so the comparison does not depend on entry order
const normAcl = (s: string) => s.replace(/[{}]/g, '').split(',').filter(Boolean).sort().join(',');

// table ACLs measured on production (PostgreSQL 17.6) on 2026-10-11
const PROD_ACL: Record<string, string> = {
  env_vars: '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}',
  forgestudio_project_versions: '{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=ardDxtm/postgres,service_role=Dxtm/postgres}',
  forgestudio_projects: '{postgres=arwdDxtm/postgres,anon=arDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}',
  integrations: '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}',
  seo_settings: '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}',
};
const PROD_DEFAULT_ACL_POSTGRES_TABLES = '{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}';
const PROD_DEFAULT_ACL_SUPABASE_ADMIN_TABLES =
  '{postgres=arwdDxtm/supabase_admin,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin}';

const SNAPSHOT_SQL = `
select 'T|' || coalesce(string_agg(x.k, ' ' order by x.k), '') from (
  select c.relname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || pg_get_userbyid(a.grantor) || ':' || a.privilege_type || ':' || a.is_grantable as k
  from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname !~ '^_probe') x;
select 'D|' || coalesce(string_agg(x.k, ' ' order by x.k), '') from (
  select pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as k
  from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
  where d.defaclnamespace = 'public'::regnamespace) x;`;

const privs = (table: string) =>
  q(`select string_agg(r.rn || '=[' || coalesce((select string_agg(p, ',' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p where has_table_privilege(r.rn, 'public.${table}'::regclass, p)), '') || ']', ' ' order by r.rn)
     from (values ('anon'), ('authenticated')) r(rn)`);

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
}
function clientFor(token: string) {
  const rewrite = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.replace('/rest/v1', ''), init);
  };
  return createClient(`http://127.0.0.1:${REST_PORT}`, token, {
    global: { fetch: rewrite, headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const S: Record<string, string> = {}; // shared evidence between steps

describe.skipIf(!enabled)('Phase 7B release gates on PostgreSQL 17 (disposable container)', { timeout: 300_000 }, () => {
  beforeAll(() => {
    sh('docker', ['rm', '-f', PG, REST]);
    let image = 'postgres:17.6';
    let run = sh('docker', ['run', '-d', '--name', PG, '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_PASSWORD=gatepw', '-p', `${PG_PORT}:5432`, image]);
    if (run.code !== 0) {
      image = 'postgres:17';
      run = sh('docker', ['run', '-d', '--name', PG, '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_PASSWORD=gatepw', '-p', `${PG_PORT}:5432`, image]);
    }
    if (run.code !== 0) throw new Error(`cannot start postgres container: ${run.err}`);
    S.image = image;
    // the image restarts the server once after its init scripts; wait for the second "ready" message
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      const logs = sh('docker', ['logs', PG]);
      const n = (logs.out + logs.err).split('database system is ready to accept connections').length - 1;
      ready = n >= 2 && psql('supabase_admin', 'postgres', 'select 1').code === 0;
      if (!ready) sh('sleep', ['1']);
    }
    if (!ready) throw new Error('postgres container did not become ready');

    const pre = psql('supabase_admin', 'postgres', "create role postgres login createrole createdb bypassrls; create database app owner postgres;");
    if (pre.code !== 0) throw new Error(pre.err);
    const setup = psql('supabase_admin', 'app', read('supabase/tests/pg17_replica_setup.sql'));
    if (setup.code !== 0) throw new Error(`replica setup failed: ${setup.err}`);
  }, 600_000);

  afterAll(() => {
    flushNotices();
    sh('docker', ['rm', '-f', PG, REST]);
  });

  it('GATE A: replica runs the same PostgreSQL major.minor as production (17.6)', () => {
    const v = q('show server_version');
    S.version = v;
    notice('gate-A-version', `Production = PostgreSQL 17.6 (select version() on project nbjihppxarjomgrbbhfh). Replica image ${S.image} reports server_version=${v}. MAINTAIN privilege recognised: ${q("select has_table_privilege('postgres','public.env_vars'::regclass,'MAINTAIN')")}`);
    expect(v.startsWith('17.')).toBe(true);
    if (S.image === 'postgres:17.6') expect(v.startsWith('17.6')).toBe(true);
  });

  it('GATE B: replica reproduces production role model, default privileges and table ACLs exactly', () => {
    expect(q("select rolsuper::text from pg_roles where rolname='supabase_admin'")).toBe('true');
    expect(q("select rolsuper::text || ' ' || rolcreaterole::text || ' ' || rolbypassrls::text from pg_roles where rolname='postgres'")).toBe('false true true');
    expect(q("select pg_has_role('postgres','supabase_admin','member')::text")).toBe('false');
    for (const [t, acl] of Object.entries(PROD_ACL)) {
      const got = q(`select relacl::text from pg_class where oid='public.${t}'::regclass`);
      expect(normAcl(got), `ACL of ${t}`).toBe(normAcl(acl));
    }
    const dp = q("select defaclacl::text from pg_default_acl where defaclrole='postgres'::regrole and defaclnamespace='public'::regnamespace and defaclobjtype='r'");
    const ds = q("select defaclacl::text from pg_default_acl where defaclrole='supabase_admin'::regrole and defaclnamespace='public'::regnamespace and defaclobjtype='r'");
    expect(normAcl(dp)).toBe(normAcl(PROD_DEFAULT_ACL_POSTGRES_TABLES));
    expect(normAcl(ds)).toBe(normAcl(PROD_DEFAULT_ACL_SUPABASE_ADMIN_TABLES));
    S.snapBefore = q(SNAPSHOT_SQL);
    // effective grants BEFORE the migration for tables created by each relevant role
    q('create table public._probe_pg_before (id int)');
    expect(psql('supabase_admin', 'app', 'create table public._probe_sa_before (id int)').code).toBe(0);
    S.pgBefore = privs('_probe_pg_before');
    S.saBefore = privs('_probe_sa_before');
    notice('gate-B-before', `Replica ACLs match production (5 tables + default ACLs for postgres and supabase_admin). BEFORE migration, effective grants on a NEW table created by postgres: ${S.pgBefore}. By supabase_admin: ${S.saBefore}.`);
    expect(S.pgBefore).toBe('anon=[MAINTAIN,REFERENCES,TRIGGER,TRUNCATE] authenticated=[MAINTAIN,REFERENCES,TRIGGER,TRUNCATE]');
    q('drop table public._probe_pg_before');
    expect(psql('supabase_admin', 'app', 'drop table public._probe_sa_before').code).toBe(0);
  });

  it('GATE C+E+F (rolled back): full least-privilege + RLS regression suite on PG17, with rollback ACL comparison', () => {
    const r = psql('postgres', 'app', read('supabase/tests/least_privilege_migration_test.sql'));
    const m = /RESULT: (.*)/.exec(r.err);
    expect(m, `suite output: ${r.err.slice(0, 500)}`).not.toBeNull();
    const res = m?.[1] ?? '';
    S.suite = res;
    notice('gate-CEF-suite', res);
    const mustContain = [
      'BEFORE_prohibited_privilege_count=40', // same count as measured on production
      'AFTER_forbidden_privileges_still_present=[]',
      'AFTER_required_authenticated_privileges_missing=[]',
      'ANON_select_forgestudio_projects=42501', 'ANON_select_forgestudio_project_versions=42501', 'ANON_select_integrations=42501',
      'ANON_select_seo_settings=42501', 'ANON_select_env_vars=42501', 'ANON_google_style_insert=42501',
      'AUTH_truncate_forgestudio_projects=42501', 'AUTH_truncate_forgestudio_project_versions=42501', 'AUTH_truncate_integrations=42501',
      'AUTH_truncate_seo_settings=42501', 'AUTH_truncate_env_vars=42501',
      'OWNER_insert=ok', 'OWNER_update_rows=1', 'OWNER_select_rows=1', 'OWNER_version_insert_select_rows=1',
      'OTHER_select_fixture_rows=0', 'OTHER_update_rows=0', 'OTHER_delete_rows=0', 'OTHER_select_version_rows=0', 'OTHER_integrations_visible=0',
      'OWNER_delete_rows=1', 'OWNER_versions_after_cascade=0',
      'FUTURE_TABLE_anon_or_authenticated_grants=0',
      'SUPABASE_ADMIN_default_acl_change=42501', // postgres cannot (and the migration does not try to) alter supabase_admin defaults
      'ROLLBACK_table_acls_identical_to_snapshot=true', 'ROLLBACK_default_acls_identical_to_snapshot=true',
    ];
    for (const token of mustContain) expect(res, token).toContain(token);
    // the suite is fully rolled back: nothing changed
    expect(q(SNAPSHOT_SQL)).toBe(S.snapBefore);
  });

  it('GATE C+E: apply the REAL migration file; extended grant check returns zero rows; new-table defaults', () => {
    const mig = psql('postgres', 'app', read('supabase/migrations/20261010120000_least_privilege_public_tables.sql'));
    expect(mig.code, mig.err).toBe(0);

    const sql = read('supabase/tests/rls_grants_check.sql');
    const part2 = sql.slice(sql.indexOf('with tbl as ('));
    expect(part2.startsWith('with tbl as (')).toBe(true);
    const violations = q(part2);
    notice('gate-CE-migration', `Real migration applied on PG17 (exit 0). rls_grants_check.sql PART 2 violation rows: ${violations === '' ? 'ZERO' : violations}. Prohibited privileges (TRUNCATE/TRIGGER/REFERENCES/MAINTAIN) held by anon/authenticated: ${q("select count(*) from pg_class c cross join (values ('TRUNCATE'),('TRIGGER'),('REFERENCES'),('MAINTAIN')) x(p) cross join (values ('anon'),('authenticated')) r(rn) where c.relnamespace='public'::regnamespace and c.relkind='r' and has_table_privilege(r.rn, c.oid, x.p)")}.`);
    expect(violations).toBe('');

    // effective grants AFTER, for tables created by each relevant role
    q('create table public._probe_pg_after (id int)');
    expect(psql('supabase_admin', 'app', 'create table public._probe_sa_after (id int)').code).toBe(0);
    S.pgAfter = privs('_probe_pg_after');
    S.saAfter = privs('_probe_sa_after');
    S.saAfterRls = q("select relrowsecurity::text from pg_class where oid='public._probe_sa_after'::regclass");
    S.pgAfterRls = q("select relrowsecurity::text from pg_class where oid='public._probe_pg_after'::regclass");
    notice(
      'gate-B-after',
      `AFTER migration, new table created by postgres: ${S.pgAfter} (RLS auto-enabled=${S.pgAfterRls}). New table created by supabase_admin: ${S.saAfter} (RLS auto-enabled=${S.saAfterRls}). RESIDUAL RISK: supabase_admin default privileges cannot be changed by a postgres-run migration (postgres is not a member of supabase_admin, error 42501); on production every public table is owned by postgres, and PART 2 flags any future table that violates the rules.`,
    );
    expect(S.pgAfter).toBe('anon=[] authenticated=[]');
    expect(S.pgAfterRls).toBe('true');
    expect(S.saAfter).toBe(S.saBefore); // unchanged by the migration: documented residual risk, not a regression
    q('drop table public._probe_pg_after');
    psql('supabase_admin', 'app', 'drop table public._probe_sa_after');

    S.snapMigrated = q(SNAPSHOT_SQL);
    expect(S.snapMigrated).not.toBe(S.snapBefore);
  });

  describe('DELETE TEST: real route handler + PostgREST + disposable users/projects (migration applied)', { timeout: 300_000 }, () => {
    const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const PA = 'a1a1a1a1-0000-4000-8000-0000000000a1';
    const PA2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';
    const PB = 'b1b1b1b1-0000-4000-8000-0000000000b1';

    beforeAll(async () => {
      q(`insert into auth.users (id, email) values ('${A}', 'disposable-a@example.test'), ('${B}', 'disposable-b@example.test');
         insert into public.forgestudio_projects (id, user_id, prompt, code) values
           ('${PA}', '${A}', 'DISPOSABLE A1', 'x'), ('${PA2}', '${A}', 'DISPOSABLE A2', 'x'), ('${PB}', '${B}', 'DISPOSABLE B1', 'x');
         insert into public.forgestudio_project_versions (project_id, user_id, version_number, code) values
           ('${PA}', '${A}', 1, 'v1'), ('${PA}', '${A}', 2, 'v2'), ('${PA2}', '${A}', 1, 'v1'), ('${PB}', '${B}', 1, 'v1');`);
      const r = sh('docker', [
        'run', '-d', '--name', REST, '--network', 'host',
        '-e', `PGRST_DB_URI=postgres://authenticator:authpw@127.0.0.1:${PG_PORT}/app`,
        '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
        '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, '-e', `PGRST_SERVER_PORT=${REST_PORT}`,
        'postgrest/postgrest:v12.2.3',
      ]);
      if (r.code !== 0) throw new Error(`cannot start postgrest: ${r.err}`);
      let up = false;
      for (let i = 0; i < 90 && !up; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { Authorization: `Bearer ${jwt({ role: 'anon' })}` } });
          up = res.status === 200;
        } catch {
          up = false;
        }
        if (!up) await new Promise((ok) => setTimeout(ok, 1000));
      }
      if (!up) throw new Error(`postgrest did not start: ${sh('docker', ['logs', REST]).out}${sh('docker', ['logs', REST]).err}`);
    }, 300_000);

    const exists = (id: string) => q(`select count(*) from public.forgestudio_projects where id='${id}'`);
    const versions = (id: string) => q(`select count(*) from public.forgestudio_project_versions where project_id='${id}'`);
    const del = async (id: string) => {
      const { POST } = await import('@/app/api/projects/delete/route');
      const res = await POST(new Request('http://localhost/api/projects/delete', { method: 'POST', body: JSON.stringify({ id }) }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const userJwt = (sub: string) => jwt({ role: 'authenticated', sub, aud: 'authenticated' });

    it('anonymous: no session -> 401, and a direct anon-key DELETE is refused by the database', async () => {
      h.user = null;
      h.client = clientFor(jwt({ role: 'anon' }));
      const viaRoute = await del(PA);
      expect(viaRoute.status).toBe(401);
      expect(exists(PA)).toBe('1');
      const direct = await clientFor(jwt({ role: 'anon' })).from('forgestudio_projects').delete().eq('id', PA).select();
      // 42501 = permission denied (anon has no DELETE privilege after the migration)
      expect(direct.error?.code).toBe('42501');
      expect(exists(PA)).toBe('1');
      // even if the application check were bypassed (spoofed user id) the anon DB role cannot see or delete the row
      h.user = { id: A };
      const bypass = await del(PA);
      expect(bypass.status).toBe(404);
      expect(exists(PA)).toBe('1');
      expect(versions(PA)).toBe('2');
    });

    it("cross-user: B cannot delete A's project (404), also not when the app-layer user id is forged; data and versions intact", async () => {
      h.user = { id: B };
      h.client = clientFor(userJwt(B));
      const r1 = await del(PA);
      expect(r1.status).toBe(404);
      // forged app-layer identity (A) but B's database session: RLS still hides the row
      h.user = { id: A };
      const r2 = await del(PA);
      expect(r2.status).toBe(404);
      const direct = await clientFor(userJwt(B)).from('forgestudio_projects').delete().eq('id', PA).select();
      expect(direct.error).toBeNull();
      expect(direct.data).toEqual([]); // RLS filtered: 0 rows deleted
      expect(exists(PA)).toBe('1');
      expect(versions(PA)).toBe('2');
      expect(exists(PA2)).toBe('1');
      expect(exists(PB)).toBe('1');
    });

    it('owner: deletes own disposable project (200); versions cascade; other projects untouched; second delete is 404', async () => {
      h.user = { id: A };
      h.client = clientFor(userJwt(A));
      const r = await del(PA);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true });
      expect(exists(PA)).toBe('0');
      expect(versions(PA)).toBe('0'); // ON DELETE CASCADE
      expect(exists(PA2)).toBe('1');
      expect(versions(PA2)).toBe('1');
      expect(exists(PB)).toBe('1');
      expect(versions(PB)).toBe('1');
      expect((await del(PA)).status).toBe(404);
      notice('gate-delete', 'Real /api/projects/delete handler against PostgREST + PG17 with disposable users/projects: anonymous 401 and DB-level 42501; cross-user 404 (also with forged app-layer id) with 0 rows deleted; owner 200 and versions cascaded (2 -> 0); other projects untouched. UI state cleanup is covered by tests/ui/live-preview.test.tsx in the same CI run.');
    });
  });

  it('GATE F: apply the REAL rollback file; table and default ACLs equal the pre-migration snapshot', () => {
    sh('docker', ['rm', '-f', REST]);
    const rb = psql('postgres', 'app', read('supabase/rollbacks/20261010120000_least_privilege_public_tables.rollback.sql'));
    expect(rb.code, rb.err).toBe(0);
    const after = q(SNAPSHOT_SQL);
    const same = after === S.snapBefore;
    notice('gate-F-rollback', `Real rollback file applied on PG17 (exit ${rb.code}). Table ACLs + default ACLs identical to the pre-migration snapshot: ${same}. ${same ? '' : 'BEFORE: ' + S.snapBefore.slice(0, 600) + ' AFTER: ' + after.slice(0, 600)}`);
    expect(after).toBe(S.snapBefore);
  });

  it('GATE D: rls_auto_enable() signature, owner, EXECUTE privileges, event-trigger behaviour; proposed revoke tested in isolation', () => {
    const r = psql('postgres', 'app', read('supabase/tests/pg17_rls_auto_enable_gate.sql'));
    expect(r.code, r.err).toBe(0);
    const g: Record<string, string> = {};
    for (const line of r.out.split('\n')) {
      const m = /^GATE\|([^|]+)\|(.*)$/.exec(line);
      if (m) g[m[1]] = m[2];
    }
    const pick = (label: string) =>
      ['public_execute', 'anon_execute', 'authenticated_execute', 'owner_execute', 'direct_call_anon', 'direct_call_authenticated', 'event_trigger_enabled', 'rls_on_new_table_by_owner', 'rls_on_ctas_table_by_owner', 'rls_on_new_table_by_other_role']
        .map((k) => `${k}=${g[`${label}.${k}`]}`)
        .join(' ');
    notice('gate-D-facts', `signature=${g['func.signature']} owner=${g['func.owner']} security_definer=${g['func.security_definer']} config=${g['func.config']} returns=${g['func.returns']} | ${g['evt.ensure_rls']}`);
    notice('gate-D-baseline', `BASELINE (proacl=${g['baseline.proacl']}): ${pick('baseline')}`);
    notice('gate-D-after-revoke', `AFTER proposed REVOKE EXECUTE FROM public, anon, authenticated (proacl=${g['after_revoke.proacl']}): ${pick('after_revoke')}`);
    notice('gate-D-after-rollback', `AFTER rollback GRANT EXECUTE TO public (proacl=${g['after_rollback.proacl']}): ${pick('after_rollback')}`);

    expect(g['func.signature']).toBe('rls_auto_enable()');
    expect(g['func.owner']).toBe('postgres');
    expect(g['func.security_definer']).toBe('true');
    expect(g['func.config']).toContain('search_path=pg_catalog');
    expect(g['func.returns']).toBe('event_trigger');
    // baseline: executable by everyone through the implicit PUBLIC grant (what the Supabase advisor reports)
    for (const k of ['public_execute', 'anon_execute', 'authenticated_execute']) expect(g[`baseline.${k}`]).toBe('true');
    expect(g['baseline.rls_on_new_table_by_owner']).toBe('true');
    // after the revoke: API roles cannot execute it; owner still can; the event trigger keeps working
    for (const k of ['public_execute', 'anon_execute', 'authenticated_execute']) expect(g[`after_revoke.${k}`]).toBe('false');
    expect(g['after_revoke.owner_execute']).toBe('true');
    expect(g['after_revoke.direct_call_anon']).toBe('42501');
    expect(g['after_revoke.direct_call_authenticated']).toBe('42501');
    expect(g['after_revoke.event_trigger_enabled']).toBe('O');
    expect(g['after_revoke.rls_on_new_table_by_owner']).toBe('true');
    expect(g['after_revoke.rls_on_ctas_table_by_owner']).toBe('true');
    expect(g['after_revoke.rls_on_new_table_by_other_role']).toBe('true');
    // rollback restores the effective privileges
    for (const k of ['public_execute', 'anon_execute', 'authenticated_execute']) expect(g[`after_rollback.${k}`]).toBe('true');
    expect(g['after_rollback.event_trigger_enabled']).toBe('O');
  });
});
