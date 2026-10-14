import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PHASE 7B BACKUP / RESTORE VALIDATION against DISPOSABLE PostgreSQL 17.6 containers (never production).
//
// Two pinned `postgres:17.6` containers are started: SRC (rebuilt from supabase/tests/pg17_replica_setup.sql plus synthetic
// fixtures) and TGT (an empty restore target). Every client binary (pg_dump, pg_restore, psql) runs INSIDE those containers, so the
// client version IS the 17.6 server image version. Nothing here connects to Supabase; all data is synthetic.
//
// Credential handling: no password is ever placed in an argument list. Passwords are handed to `docker exec -e PGPASSWORD` /
// `docker run -e POSTGRES_PASSWORD` WITHOUT a value, so docker copies them from this process's environment. PGPASSWORD therefore
// exists in the environment of the docker client and of the exec'd process (readable by the same OS user and by `docker inspect`
// of a running exec). That exposure is accepted ONLY because the passwords are random, per-run and guard throw-away containers.
// The role `postgres` password is set through SQL on stdin, the GPG passphrase is sent on stdin (--passphrase-fd 0).
//
// Dumps are never printed: binary output is kept in memory/files, and a leak scan at the end proves that no canary value or password
// appears in any recorded argument list, stdout or stderr.
//
// Needs Docker, so it runs in CI (CI=true) or with RUN_DB_GATES=1 and is skipped otherwise. Evidence is printed as `::notice`.

const enabled = Boolean(process.env.CI || process.env.RUN_DB_GATES);
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

// The exact flags of the tested dump / restore commands. docs/PHASE-7B-BACKUP-RUNBOOK.md must carry the same flags.
export const DUMP_FLAGS = ['-w', '--schema=public', '--format=custom'] as const;
export const RESTORE_FLAGS = ['-w', '--single-transaction'] as const;
export const GPG_FLAGS = ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--symmetric', '--cipher-algo', 'AES256'] as const;

// Catalog categories that MUST be identical after a restore; D / E / Edep / N are "observed" (see compare logic)
export const STRICT = ['T', 'C', 'K', 'I', 'P', 'A', 'F', 'R', 'H'];
const cat = (line: string) => line.slice(0, line.indexOf('|'));
// regprocedure text omits the schema when `public` is on the search_path, so match on the function name only
const isRlsFn = (l: string) => l.startsWith('F|') && l.includes('rls_auto_enable()');

// ---- pure helpers (also exercised without Docker) ----
export function assertPg176(text: string, what: string): void {
  if (!/(^|[^0-9.])17\.6(\.|\s|$)/.test(text.trim())) throw new Error(`${what} is not PostgreSQL 17.6: ${text.trim().slice(0, 80)}`);
}
export function diffSnap(a: string[], b: string[], categories?: string[]): string[] {
  const keep = (l: string) => !categories || categories.includes(cat(l));
  const A = new Set(a.filter(keep));
  const B = new Set(b.filter(keep));
  return [...[...A].filter((l) => !B.has(l)).map((l) => `- ${l}`), ...[...B].filter((l) => !A.has(l)).map((l) => `+ ${l}`)].sort();
}
export function findLeaks(haystack: string, secrets: string[]): string[] {
  return secrets.filter((s) => s.length >= 8 && haystack.includes(s)).map((s) => `${s.slice(0, 4)}…(${s.length})`);
}

describe('backup validation helpers (no Docker needed)', () => {
  it('version guard accepts 17.6.x and rejects 16.x / 17.5 / empty', () => {
    expect(() => assertPg176('pg_dump (PostgreSQL) 17.6', 'x')).not.toThrow();
    expect(() => assertPg176('17.6 (Debian 17.6-1.pgdg120+1)', 'x')).not.toThrow();
    expect(() => assertPg176('pg_dump (PostgreSQL) 16.4', 'x')).toThrow(/not PostgreSQL 17\.6/);
    expect(() => assertPg176('17.5', 'x')).toThrow();
    expect(() => assertPg176('', 'x')).toThrow();
  });
  it('snapshot diff reports missing and extra lines only within the requested categories', () => {
    const a = ['R|t|3', 'H|t|aa', 'D|x|y'];
    const b = ['R|t|2', 'H|t|aa', 'D|x|z'];
    expect(diffSnap(a, a)).toEqual([]);
    expect(diffSnap(a, b, STRICT)).toEqual(['+ R|t|2', '- R|t|3']);
    expect(diffSnap(a, b, ['D'])).toEqual(['+ D|x|z', '- D|x|y']);
  });
  it('leak scan finds secrets and ignores short tokens', () => {
    expect(findLeaks('hello canary-abcdef123456 bye', ['canary-abcdef123456'])).toHaveLength(1);
    expect(findLeaks('hello', ['canary-abcdef123456', 'x'])).toEqual([]);
  });
});

// ---- process helpers ----
type Res = { code: number; out: string; err: string; buf: Buffer };
const LOG: string[] = []; // every argument list + captured text (never stdin, never binary stdout) for the leak scan
function run(cmd: string, args: string[], o: { input?: string | Buffer; env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Res {
  LOG.push(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    input: o.input, env: o.env ?? process.env, cwd: o.cwd, timeout: o.timeout ?? 240_000, maxBuffer: 256 * 1024 * 1024, // no `encoding` option: spawnSync then returns Buffers, which keeps dumps binary-safe
  });
  const buf = r.stdout ?? Buffer.alloc(0);
  const err = (r.stderr ? r.stderr.toString('utf8') : '') + (r.error ? String(r.error.message) : '');
  const out = buf.toString('utf8');
  LOG.push(err);
  if (buf.length < 100_000 && !buf.includes(0)) LOG.push(out); // never record dump (binary) output
  return { code: r.status ?? -1, out, err, buf };
}
// run a command inside container `c`; `pw` is handed over through the environment (docker copies PGPASSWORD from this process)
function dx(c: string, argv: string[], o: { input?: string | Buffer; pw?: string } = {}): Res {
  const args = ['exec', ...(o.input !== undefined ? ['-i'] : []), ...(o.pw !== undefined ? ['-e', 'PGPASSWORD'] : []), c, ...argv];
  return run('docker', args, { input: o.input, env: o.pw !== undefined ? { ...process.env, PGPASSWORD: o.pw } : process.env });
}
// local-socket psql as `user` (peer is trust inside the image); SQL on stdin
function sql(c: string, db: string, text: string, user = 'supabase_admin'): Res {
  return dx(c, ['psql', '-U', user, '-d', db, '-X', '-At', '-v', 'ON_ERROR_STOP=1'], { input: text });
}
function mustSql(c: string, db: string, text: string, user = 'supabase_admin'): string {
  const r = sql(c, db, text, user);
  if (r.code !== 0) throw new Error(`SQL failed (exit ${r.code}): ${r.err.split('\n')[0]}`);
  return r.out.trim();
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rand = (n = 12) => randomBytes(n).toString('hex');
const first = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 110);
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

// ---- state ----
const RUN = rand(4);
const SRC = `forge-bk-src-${RUN}`;
const TGT = `forge-bk-tgt-${RUN}`;
const LABEL = `forge-backup-validation=${RUN}`;
const PW_ADMIN = `pw-admin-${rand()}`;
const PW_POSTGRES = `pw-pg-${rand()}`;
const PW_WRONG = `pw-wrong-${rand()}`;
const GPG_PASS = `gpg-pass-${rand()}`;
const GPG_WRONG = `gpg-wrong-${rand()}`;
const CANARY = { access: `canary-access-${rand()}`, refresh: `canary-refresh-${rand()}`, env: `canary-env-${rand()}` };
const SECRETS = [PW_ADMIN, PW_POSTGRES, PW_WRONG, GPG_PASS, GPG_WRONG, ...Object.values(CANARY)];

const S: Record<string, string> = {};
let WORK = '';
let srcIp = '';
let tgtIp = '';
let srcSnap: string[] = [];
let restoredSnap: string[] = [];

const BUF: { title: string; msg: string }[] = [];
const notice = (title: string, msg: string) => BUF.push({ title, msg });
function flushNotices() {
  const groups: [string, string][] = [
    ['backup-A-versions-artifact', 'A-'],
    ['backup-B-restore-compare', 'B-'],
    ['backup-C-failures-leaks-cleanup', 'C-'],
  ];
  for (const [title, prefix] of groups) {
    const text = BUF.filter((b) => b.title.startsWith(prefix)).map((b) => `[${b.title}] ${b.msg}`).join('\n');
    console.log(`::notice title=${title}::${text.replace(/%/g, '%25').replace(/\r?\n/g, '%0A').slice(0, 5000)}`);
  }
}

// ---- the operations under test ----
// Backup: dump over TCP (password authentication enforced) into <file>.partial, rename only after a successful, non-empty dump.
function backup(c: string, ip: string, user: string, pw: string, db: string, file: string): { ok: boolean; why: string } {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const r = dx(c, ['pg_dump', '-h', ip, '-p', '5432', '-U', user, '-d', db, ...DUMP_FLAGS], { pw });
  if (r.code !== 0) return { ok: false, why: `pg_dump exit ${r.code}: ${first(r.err)}` };
  if (r.buf.length === 0) return { ok: false, why: 'pg_dump produced an empty artifact' };
  writeFileSync(partial, r.buf, { mode: 0o600 });
  renameSync(partial, file);
  return { ok: true, why: `${r.buf.length} bytes` };
}
const writeSums = (dir: string, files: string[]) =>
  writeFileSync(path.join(dir, 'SHA256SUMS'), files.map((f) => `${sha256(readFileSync(path.join(dir, f)))}  ${f}`).join('\n') + '\n', { mode: 0o600 });
// Verify: exists, non-empty, SHA-256 matches, and pg_restore can read its table of contents (TOC is counted, never printed).
function verifyArtifact(dir: string, name: string, c: string): { ok: boolean; why: string; toc: number; data: number } {
  const f = path.join(dir, name);
  if (!existsSync(f)) return { ok: false, why: 'missing', toc: 0, data: 0 };
  if (statSync(f).size === 0) return { ok: false, why: 'empty', toc: 0, data: 0 };
  const sums = run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir });
  if (sums.code !== 0) return { ok: false, why: 'checksum mismatch', toc: 0, data: 0 };
  const inC = `/tmp/verify-${rand(4)}.dump`;
  const cp = run('docker', ['cp', f, `${c}:${inC}`]);
  if (cp.code !== 0) return { ok: false, why: 'docker cp failed', toc: 0, data: 0 };
  const list = dx(c, ['pg_restore', '--list', inC]);
  dx(c, ['rm', '-f', inC]);
  const lines = list.out.split('\n').filter((l) => l && !l.startsWith(';'));
  if (list.code !== 0 || lines.length < 5) return { ok: false, why: 'unreadable archive', toc: lines.length, data: 0 };
  return { ok: true, why: 'ok', toc: lines.length, data: lines.filter((l) => / TABLE DATA public /.test(l)).length };
}
function restore(c: string, ip: string, db: string, file: string): Res {
  const inC = `/tmp/restore-${rand(4)}.dump`;
  const cp = run('docker', ['cp', file, `${c}:${inC}`]);
  if (cp.code !== 0) return { code: 99, out: '', err: 'docker cp failed', buf: Buffer.alloc(0) };
  const r = dx(c, ['pg_restore', '-h', ip, '-p', '5432', '-U', 'supabase_admin', '-d', db, ...RESTORE_FLAGS, inC], { pw: PW_ADMIN });
  dx(c, ['rm', '-f', inC]);
  return r;
}
function newTarget(db: string) {
  mustSql(TGT, 'postgres', `create database ${db} owner postgres`);
  mustSql(TGT, db, read('supabase/tests/pg17-backup-target-prep.sql'));
}
const snap = (c: string, db: string) => mustSql(c, db, read('supabase/tests/pg17-backup-verify.sql')).split('\n').filter(Boolean);

const EVENT_TRIGGER_DDL =
  "create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();";
const DEFAULT_ACL_DDL = [
  'alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;',
  'alter default privileges for role postgres in schema public grant all on tables to postgres;',
  'alter default privileges for role postgres in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;',
].join('\n');

function startContainer(name: string) {
  const r = run('docker', ['run', '-d', '--name', name, '--label', LABEL, '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_PASSWORD', 'postgres:17.6'], {
    env: { ...process.env, POSTGRES_PASSWORD: PW_ADMIN },
  });
  if (r.code !== 0) throw new Error(`cannot start postgres:17.6 (${name}): ${first(r.err)}`); // no fallback image on purpose
  for (let i = 0; i < 120; i++) {
    const logs = run('docker', ['logs', name]);
    const n = (logs.out + logs.err).split('database system is ready to accept connections').length - 1;
    if (n >= 2 && sql(name, 'postgres', 'select 1').code === 0) return;
    run('sleep', ['1']);
  }
  throw new Error(`${name} did not become ready`);
}
const ipOf = (name: string) => run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name]).out.trim();

function cleanup() {
  const ids = run('docker', ['ps', '-aq', '--filter', `label=${LABEL}`]).out.split('\n').filter(Boolean);
  if (ids.length) run('docker', ['rm', '-f', ...ids]);
  if (WORK && path.basename(WORK).startsWith('forge-bk-') && !WORK.startsWith(ROOT)) {
    run('gpgconf', ['--homedir', path.join(WORK, 'gnupg'), '--kill', 'all']);
    rmSync(WORK, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)('Phase 7B backup/restore validation on PostgreSQL 17.6 (disposable containers, synthetic data)', { timeout: 600_000 }, () => {
  beforeAll(() => {
    WORK = mkdtempSync(path.join(os.tmpdir(), 'forge-bk-'));
    chmodSync(WORK, 0o700);
    for (const d of ['store-a', 'store-b', 'extract', 'gnupg', 'stage']) mkdirSync(path.join(WORK, d), { mode: 0o700 });
    startContainer(SRC);
    startContainer(TGT);
    srcIp = ipOf(SRC);
    tgtIp = ipOf(TGT);
    for (const c of [SRC, TGT]) mustSql(c, 'postgres', "create role postgres login createrole createdb bypassrls;");
    mustSql(SRC, 'postgres', `alter role postgres password '${PW_POSTGRES}'`);
    mustSql(SRC, 'postgres', 'create database app owner postgres');
    mustSql(SRC, 'app', read('supabase/tests/pg17_replica_setup.sql'));
    const fixtures = read('supabase/tests/pg17-backup-fixtures.sql')
      .replaceAll('__CANARY_ACCESS__', CANARY.access).replaceAll('__CANARY_REFRESH__', CANARY.refresh).replaceAll('__CANARY_ENVVALUE__', CANARY.env);
    mustSql(SRC, 'app', fixtures, 'postgres');
  }, 900_000);

  afterAll(() => {
    flushNotices();
    cleanup();
  });

  it('A1: client and server versions are PostgreSQL 17.6 and the work area is outside the repository', () => {
    const v: string[] = [];
    for (const c of [SRC, TGT]) {
      for (const tool of ['pg_dump', 'pg_restore', 'psql']) {
        const r = dx(c, [tool, '--version']);
        expect(r.code, `${tool} --version`).toBe(0);
        assertPg176(r.out, `${tool} in ${c}`);
        if (c === SRC) v.push(first(r.out));
      }
      const server = mustSql(c, 'postgres', 'show server_version');
      assertPg176(server, `server ${c}`);
      v.push(`${c === SRC ? 'src' : 'tgt'} server=${server}`);
    }
    S.image = run('docker', ['image', 'inspect', 'postgres:17.6', '--format', '{{.Id}}']).out.trim().slice(0, 19);
    expect(WORK.startsWith(ROOT)).toBe(false);
    notice('A-versions', `image=postgres:17.6 id=${S.image}; ${v.join('; ')}; workdir outside repo=yes; gpg=${first(run('gpg', ['--version']).out)}`);
  });

  it('A2: password authentication is enforced on the TCP path used for dump and restore', () => {
    const noPw = run('docker', ['exec', SRC, 'psql', '-h', srcIp, '-U', 'postgres', '-d', 'app', '-w', '-X', '-At', '-c', 'select 1']);
    expect(noPw.code).not.toBe(0);
    const ok = dx(SRC, ['psql', '-h', srcIp, '-U', 'postgres', '-d', 'app', '-w', '-X', '-At', '-c', 'select 1'], { pw: PW_POSTGRES });
    expect(ok.code).toBe(0);
    notice('A-auth', `TCP without password -> exit ${noPw.code} (${first(noPw.err)}); with PGPASSWORD from environment -> exit ${ok.code}`);
  });

  it('A3: synthetic source has the expected shape before backup', () => {
    srcSnap = snap(SRC, 'app');
    const rows = srcSnap.filter((l) => l.startsWith('R|')).join(' ');
    expect(rows).toContain('R|forgestudio_projects|4');
    expect(rows).toContain('R|forgestudio_project_versions|0');
    expect(rows).toContain('R|integrations|3');
    expect(rows).toContain('R|seo_settings|2');
    expect(rows).toContain('R|env_vars|2');
    expect(srcSnap.some((l) => l.startsWith('E|ensure_rls|'))).toBe(true);
    expect(srcSnap.some(isRlsFn)).toBe(true);
    const counts = Object.fromEntries(['T', 'C', 'K', 'I', 'P', 'A', 'F', 'R', 'H', 'D', 'E', 'Edep', 'N'].map((k) => [k, srcSnap.filter((l) => cat(l) === k).length]));
    S.counts = JSON.stringify(counts);
    notice('A-source', `snapshot lines by category ${S.counts}; rows ${rows}`);
  });

  it('A4: pg_dump (custom format, schema public) succeeds, is non-empty, SHA-256 verifies and the archive is readable', () => {
    const stage = path.join(WORK, 'stage');
    const dump = path.join(stage, 'forgestudio-public.dump');
    const b = backup(SRC, srcIp, 'postgres', PW_POSTGRES, 'app', dump);
    expect(b.ok, b.why).toBe(true);
    expect(existsSync(`${dump}.partial`)).toBe(false);
    writeFileSync(path.join(stage, 'source.snapshot'), srcSnap.join('\n') + '\n', { mode: 0o600 });
    writeSums(stage, ['forgestudio-public.dump', 'source.snapshot']);
    const v = verifyArtifact(stage, 'forgestudio-public.dump', SRC);
    expect(v.ok, v.why).toBe(true);
    expect(v.data).toBe(5); // five application tables carry TABLE DATA entries (the empty one included)
    S.dumpSha = sha256(readFileSync(dump));
    S.dumpSize = String(statSync(dump).size);
    notice('A-artifact', `${DUMP_FLAGS.join(' ')}; size=${S.dumpSize}B sha256=${S.dumpSha.slice(0, 16)}…; sha256sum -c OK; pg_restore --list entries=${v.toc} TABLE DATA entries=${v.data}; dump produced over TCP as role postgres (non-superuser)`);
  });

  it('A5: GPG AES-256 symmetric encryption of the bundle, decrypt round trip, two protected copies, plaintext removed', () => {
    const stage = path.join(WORK, 'stage');
    const gpgHome = path.join(WORK, 'gnupg');
    const tarPath = path.join(WORK, 'bundle.tar');
    const tar = run('tar', ['-cf', tarPath, '-C', stage, 'forgestudio-public.dump', 'source.snapshot', 'SHA256SUMS']);
    expect(tar.code).toBe(0);
    const encrypted = path.join(WORK, 'store-a', 'forgestudio-backup.tar.gpg');
    const enc = run('gpg', ['--homedir', gpgHome, ...GPG_FLAGS, '--output', encrypted, tarPath], { input: `${GPG_PASS}\n` });
    expect(enc.code, first(enc.err)).toBe(0);
    chmodSync(encrypted, 0o600);
    const packets = run('gpg', ['--homedir', gpgHome, '--list-packets', encrypted]);
    expect(packets.err + packets.out).toContain('AES256');
    // the encrypted artifact must not contain canary plaintext
    expect(findLeaks(readFileSync(encrypted).toString('latin1'), Object.values(CANARY))).toEqual([]);
    // outer checksum + second protected location
    writeFileSync(path.join(WORK, 'store-a', 'SHA256SUMS'), `${sha256(readFileSync(encrypted))}  forgestudio-backup.tar.gpg\n`, { mode: 0o600 });
    copyFileSync(encrypted, path.join(WORK, 'store-b', 'forgestudio-backup.tar.gpg'));
    copyFileSync(path.join(WORK, 'store-a', 'SHA256SUMS'), path.join(WORK, 'store-b', 'SHA256SUMS'));
    chmodSync(path.join(WORK, 'store-b', 'forgestudio-backup.tar.gpg'), 0o600);
    chmodSync(path.join(WORK, 'store-b', 'SHA256SUMS'), 0o600);
    for (const d of ['store-a', 'store-b']) {
      const c = run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: path.join(WORK, d) });
      expect(c.code, `${d} checksum`).toBe(0);
    }
    // plaintext removed; only encrypted material remains in the stores
    rmSync(tarPath, { force: true });
    expect(existsSync(tarPath)).toBe(false);
    // decrypt a copy from location B and re-verify the inner checksums
    const extractDir = path.join(WORK, 'extract');
    const tarOut = path.join(WORK, 'extract.tar');
    const dec = run('gpg', ['--homedir', gpgHome, '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', '--output', tarOut, path.join(WORK, 'store-b', 'forgestudio-backup.tar.gpg')], { input: `${GPG_PASS}\n` });
    expect(dec.code, first(dec.err)).toBe(0);
    expect(run('tar', ['-xf', tarOut, '-C', extractDir]).code).toBe(0);
    rmSync(tarOut, { force: true });
    expect(run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: extractDir }).code).toBe(0);
    expect(sha256(readFileSync(path.join(extractDir, 'forgestudio-public.dump')))).toBe(S.dumpSha);
    // permissions
    expect(mode(WORK)).toBe('700');
    expect(mode(encrypted)).toBe('600');
    expect(mode(path.join(WORK, 'store-b', 'forgestudio-backup.tar.gpg'))).toBe('600');
    // wrong passphrase must fail
    const bad = run('gpg', ['--homedir', gpgHome, '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', '--output', path.join(WORK, 'wrong.tar'), encrypted], { input: `${GPG_WRONG}\n` });
    expect(bad.code).not.toBe(0);
    expect(existsSync(path.join(WORK, 'wrong.tar')) && statSync(path.join(WORK, 'wrong.tar')).size > 0).toBe(false);
    S.gpgCipher = first((packets.err + packets.out).split('\n').find((l) => l.includes('AES256')) ?? '');
    notice('A-encryption', `gpg symmetric: ${S.gpgCipher}; encrypted=${statSync(encrypted).size}B; two copies verified by sha256sum -c; decrypt round trip identical sha256; wrong passphrase -> exit ${bad.code}; modes dir=700 files=600; canary plaintext in .gpg=none; plaintext tar removed`);
  });

  it('B1: restore (from the DECRYPTED copy) into a fresh, separate database succeeds', () => {
    newTarget('restored');
    const r = restore(TGT, tgtIp, 'restored', path.join(WORK, 'extract', 'forgestudio-public.dump'));
    expect(r.code, first(r.err)).toBe(0);
    notice('B-restore', `pg_restore ${RESTORE_FLAGS.join(' ')} as supabase_admin over TCP into a new database on a separate container -> exit ${r.code}; target-prep (roles, auth stand-in) run first`);
  });

  it('B2: restored schema, data and security state match the source (strict categories)', () => {
    restoredSnap = snap(TGT, 'restored');
    const diff = diffSnap(srcSnap, restoredSnap, STRICT);
    expect(diff).toEqual([]);
    const n = (k: string) => srcSnap.filter((l) => cat(l) === k).length;
    const counts = { tables: n('T'), cols: n('C'), constraints: n('K'), indexes: n('I'), policies: n('P'), tableAcls: n('A'), functions: n('F'), rowCounts: n('R'), contentHashes: n('H') };
    // spot assertions so a vacuous (empty) snapshot cannot pass
    expect(counts.tables).toBe(5);
    expect(counts.rowCounts).toBe(5);
    expect(counts.contentHashes).toBe(5);
    expect(srcSnap.filter((l) => l.startsWith('K|') && l.includes('|p|')).length).toBeGreaterThanOrEqual(5);
    expect(srcSnap.filter((l) => l.startsWith('K|') && l.includes('|f|')).length).toBeGreaterThanOrEqual(1);
    expect(srcSnap.some((l) => l.includes('forgestudio_projects_user_id_idx'))).toBe(true);
    expect(srcSnap.some((l) => l.includes('forgestudio_project_versions_version_number_check'))).toBe(true);
    // empty table restored empty with its definition
    expect(restoredSnap).toContain('R|forgestudio_project_versions|0');
    // synthetic secrets exist in the restored data (they are in the dump: dumps ARE sensitive), checked without printing them
    expect(mustSql(TGT, 'restored', `select count(*) from public.integrations where access_token = '${CANARY.access}'`)).toBe('3');
    expect(mustSql(TGT, 'restored', `select count(*) from public.env_vars where value = '${CANARY.env}'`)).toBe('1');
    // foreign keys really enforce after restore (insert with an unknown user must fail)
    const fk = sql(TGT, 'restored', "insert into public.seo_settings (id, user_id) values ('44444444-0000-4000-8000-0000000000ff', '99999999-9999-4999-8999-999999999999')");
    expect(fk.code).not.toBe(0);
    expect(fk.err).toContain('violates foreign key constraint');
    notice('B-compare', `strict categories ${STRICT.join(' ')} identical (0 diff lines): ${JSON.stringify(counts)}; empty table restored empty; synthetic secrets present in restored data (dump is sensitive), not printed; FK enforced`);
  });

  it('B3: default privileges, schema ACL, rls_auto_enable() and the event trigger are accounted for', () => {
    const rls = restoredSnap.filter(isRlsFn);
    expect(rls).toHaveLength(1);
    expect(rls).toEqual(srcSnap.filter(isRlsFn));
    expect(rls[0]).toContain('secdef=true');
    // N: schema-level ACL (observed)
    const nSrc = srcSnap.filter((l) => cat(l) === 'N');
    const nTgt = restoredSnap.filter((l) => cat(l) === 'N');
    const nEq = diffSnap(nSrc, nTgt).length === 0;
    // E / Edep: the dump of `--schema=public` does not carry event triggers; verify, then recover with superuser DDL and re-assert
    const eBefore = restoredSnap.filter((l) => cat(l) === 'E' || cat(l) === 'Edep');
    const eSrc = srcSnap.filter((l) => cat(l) === 'E' || cat(l) === 'Edep');
    expect(eSrc.length).toBe(2);
    const eRestoredByDump = eBefore.length > 0;
    // D: default ACLs (observed first, then recovered if needed)
    const dSrc = srcSnap.filter((l) => cat(l) === 'D');
    expect(dSrc.length).toBeGreaterThanOrEqual(2);
    const dBefore = diffSnap(dSrc, restoredSnap.filter((l) => cat(l) === 'D'));
    if (!eRestoredByDump) mustSql(TGT, 'restored', EVENT_TRIGGER_DDL);
    if (dBefore.length > 0) mustSql(TGT, 'restored', DEFAULT_ACL_DDL);
    const after = snap(TGT, 'restored');
    expect(diffSnap(srcSnap, after, ['D', 'E', 'Edep']), 'default ACL / event trigger state after documented recovery').toEqual([]);
    expect(diffSnap(srcSnap, after, STRICT)).toEqual([]);
    expect(after.find((l) => l.startsWith('E|ensure_rls|'))).toContain('owner=supabase_admin');
    expect(after.find((l) => l.startsWith('E|ensure_rls|'))).toContain('enabled=O');
    restoredSnap = after;
    notice('B-security', `rls_auto_enable() restored identical (owner, SECURITY DEFINER, ACL, source md5); schema ACL (N) identical=${nEq}${nEq ? '' : ` DIFF ${nSrc.join(' ')} => ${nTgt.join(' ')}`}; event trigger in dump=${eRestoredByDump ? 'yes' : 'NO -> recreated by documented superuser DDL, then definition/enabled/owner/dependency lines equal source'}; default ACLs preserved by dump=${dBefore.length === 0 ? 'yes' : `NO (${dBefore.length} diff lines) -> recreated by documented DDL, then equal`}`);
  });

  it('C1: failed dump scenarios fail and leave no artifact (missing database, wrong password)', () => {
    const missing = backup(SRC, srcIp, 'postgres', PW_POSTGRES, `no_such_db_${RUN}`, path.join(WORK, 'stage', 'missing-db.dump'));
    expect(missing.ok).toBe(false);
    const wrong = backup(SRC, srcIp, 'postgres', PW_WRONG, 'app', path.join(WORK, 'stage', 'wrong-pw.dump'));
    expect(wrong.ok).toBe(false);
    const left = readdirSync(path.join(WORK, 'stage'));
    expect(left.some((f) => f.startsWith('missing-db') || f.startsWith('wrong-pw'))).toBe(false);
    notice('C-dump-failures', `missing database -> ok=false (${missing.why}); wrong password -> ok=false (${wrong.why}); no artifact or .partial left`);
  });

  it('C2: missing, empty, truncated and corrupted artifacts and checksum mismatches are rejected', () => {
    const d = mkdtempSync(path.join(WORK, 'neg-'));
    const good = readFileSync(path.join(WORK, 'extract', 'forgestudio-public.dump'));
    // missing
    expect(verifyArtifact(d, 'absent.dump', SRC).why).toBe('missing');
    // empty
    writeFileSync(path.join(d, 'empty.dump'), '');
    expect(verifyArtifact(d, 'empty.dump', SRC).why).toBe('empty');
    // truncated (first 1 KiB) with checksums of the GOOD file => mismatch; restore of it fails too
    writeFileSync(path.join(d, 'trunc.dump'), good.subarray(0, 1024));
    writeFileSync(path.join(d, 'SHA256SUMS'), `${sha256(good)}  trunc.dump\n`);
    const t = verifyArtifact(d, 'trunc.dump', SRC);
    expect(t.ok).toBe(false);
    expect(t.why).toBe('checksum mismatch');
    mustSql(TGT, 'postgres', 'create database trunc owner postgres');
    const tr = restore(TGT, tgtIp, 'trunc', path.join(d, 'trunc.dump'));
    expect(tr.code).not.toBe(0);
    expect(mustSql(TGT, 'trunc', "select count(*) from pg_tables where schemaname = 'public'")).toBe('0');
    // tail cut (last 64 bytes): checksum catches it; the restore result is recorded, not asserted
    writeFileSync(path.join(d, 'tail.dump'), good.subarray(0, good.length - 64));
    writeFileSync(path.join(d, 'SHA256SUMS'), `${sha256(good)}  tail.dump\n`);
    expect(verifyArtifact(d, 'tail.dump', SRC).why).toBe('checksum mismatch');
    // corrupted (middle bytes flipped)
    const bad = Buffer.from(good);
    for (let i = 0; i < 16; i++) bad[Math.floor(bad.length / 2) + i] ^= 0xff;
    writeFileSync(path.join(d, 'corrupt.dump'), bad);
    writeFileSync(path.join(d, 'SHA256SUMS'), `${sha256(good)}  corrupt.dump\n`);
    expect(verifyArtifact(d, 'corrupt.dump', SRC).why).toBe('checksum mismatch');
    // checksum file itself wrong for an intact artifact
    writeFileSync(path.join(d, 'intact.dump'), good);
    writeFileSync(path.join(d, 'SHA256SUMS'), `${'0'.repeat(64)}  intact.dump\n`);
    expect(verifyArtifact(d, 'intact.dump', SRC).why).toBe('checksum mismatch');
    // control: the same intact file with the right checksum passes
    writeFileSync(path.join(d, 'SHA256SUMS'), `${sha256(good)}  intact.dump\n`);
    expect(verifyArtifact(d, 'intact.dump', SRC).ok).toBe(true);
    notice('C-artifact-failures', `missing -> rejected; empty -> rejected; truncated(1KiB) -> checksum rejected AND pg_restore exit ${tr.code} with 0 tables created; tail cut(-64B) -> checksum rejected; corrupted(16 bytes flipped) -> checksum rejected; wrong SHA256SUMS -> rejected; control (intact+correct sums) -> accepted`);
  });

  it('C3: a failed restore exits non-zero and does not change the already restored database', () => {
    const before = snap(TGT, 'restored');
    const again = restore(TGT, tgtIp, 'restored', path.join(WORK, 'extract', 'forgestudio-public.dump'));
    expect(again.code).not.toBe(0);
    const after = snap(TGT, 'restored');
    expect(diffSnap(before, after)).toEqual([]);
    notice('C-failed-restore', `second pg_restore into the populated database -> exit ${again.code} (${first(again.err)}); full snapshot unchanged (single transaction rolled back)`);
  });

  it('C4: verification detects missing rows and missing objects in a tampered restore', () => {
    newTarget('tamper');
    const r = restore(TGT, tgtIp, 'tamper', path.join(WORK, 'extract', 'forgestudio-public.dump'));
    expect(r.code, first(r.err)).toBe(0);
    mustSql(TGT, 'tamper', "delete from public.integrations where id = '33333333-0000-4000-8000-000000000003'");
    mustSql(TGT, 'tamper', 'drop index public.integrations_provider_idx');
    mustSql(TGT, 'tamper', 'drop function public.rls_auto_enable()');
    const diff = diffSnap(srcSnap, snap(TGT, 'tamper'), STRICT);
    const kinds = new Set(diff.map((l) => cat(l.slice(2))));
    for (const k of ['R', 'H', 'I', 'F']) expect(kinds.has(k), `category ${k} flagged`).toBe(true);
    notice('C-verify-detects', `tampered restore (1 row deleted, 1 index dropped, rls_auto_enable() dropped) -> diff flags categories ${[...kinds].sort().join(',')} (${diff.length} lines)`);
  });

  it('C5: missing tool or unavailable PostgreSQL 17.6 is detected', () => {
    const noTool = dx(SRC, ['pg_dump_does_not_exist', '--version']);
    expect(noTool.code).not.toBe(0);
    const noImage = run('docker', ['image', 'inspect', `forge-no-such-image-${RUN}:0`]);
    expect(noImage.code).not.toBe(0);
    expect(() => assertPg176('pg_dump (PostgreSQL) 16.4', 'simulated PG16 client')).toThrow();
    notice('C-missing-tool', `nonexistent client binary -> exit ${noTool.code}; unavailable image -> exit ${noImage.code}; guard rejects a PostgreSQL 16 client string`);
  });

  it('C6: no password, passphrase or synthetic secret appears in any recorded command line or output', () => {
    const leaks = findLeaks(LOG.join('\n'), SECRETS);
    expect(leaks).toEqual([]);
    expect(findLeaks(BUF.map((b) => b.msg).join('\n'), SECRETS)).toEqual([]);
    notice('C-leak-scan', `scanned ${LOG.length} recorded argument lines/outputs for ${SECRETS.length} secrets (3 canaries, 3 passwords, 2 gpg passphrases): 0 leaks`);
  });

  it('C7: cleanup removes only what this test created', () => {
    cleanup();
    expect(run('docker', ['ps', '-aq', '--filter', `label=${LABEL}`]).out.trim()).toBe('');
    expect(existsSync(WORK)).toBe(false);
    notice('C-cleanup', `containers ${SRC} and ${TGT} removed by label; temp dir removed; repository tree untouched`);
  });
});
