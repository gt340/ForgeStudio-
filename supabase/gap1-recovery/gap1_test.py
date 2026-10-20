#!/usr/bin/env python3
"""LOCAL tests for gap1-run.sh and gap1-inventory.sql. These prove script logic only.

They are NOT production verification:
  * Nothing here connects to Supabase. psql and the s_client handshake are stubbed in the script-flow tests; the SQL tests use a
    throw-away local server that listens on a unix socket only (listen_addresses='').
  * The SQL tests run on whatever local PostgreSQL is available (set GAP1_PG_BIN to a PostgreSQL 17 bin directory to run them on 17).
    The banner at the end states which major version actually ran. A run on 16 is NOT PostgreSQL 17 runtime evidence.
Run:  python3 gap1_test.py
"""
import glob, os, pty, re, select, shlex, shutil, signal, socket, stat, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "gap1-run.sh")
SQLF = os.path.join(HERE, "gap1-inventory.sql")
SCRATCH = os.environ.get("GAP1_TEST_TMP", tempfile.gettempdir())
PASSWORD = "Zq81-xN-test-password"
HOST = "aws-0-test-1.pooler.supabase.com"
REF = "abcdefghij0123456789"
RAN = {"pg_major": None, "static": 0}

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

# ------------------------------------------------------------------ static tests (no database, no network)
def sql_statements(text):
    """Returns (statements, meta_lines, do_bodies) for the inventory file."""
    t = re.sub(r"--[^\n]*", "", text)
    bodies = re.findall(r"\$\$(.*?)\$\$", t, re.S)
    t = re.sub(r"\$\$.*?\$\$", "$$BODY$$", t, flags=re.S)
    meta, buf = [], []
    for line in t.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("\\"):
            meta.append(s)
            continue
        m = re.match(r"^(.*?)\s*\\gset\s*$", s)
        if m:
            meta.append("\\gset")
            s = m.group(1) + ";"
        buf.append(s)
    stmts = [x.strip() for x in " ".join(buf).split(";") if x.strip()]
    return stmts, meta, bodies

class StaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sh, cls.sql = read(SCRIPT), read(SQLF)

    def test_bash_syntax(self):
        subprocess.run(["bash", "-n", SCRIPT], check=True)

    def test_plaintext_probe_removed(self):
        for bad in ("plaintext", "Step 2c", "sslmode=disable", "PGSSLMODE=disable", "02c-"):
            self.assertNotIn(bad, self.sh)

    def test_only_verify_full_and_no_tls_fallback(self):
        modes = set(re.findall(r"PGSSLMODE=([A-Za-z-]+)", self.sh)) | set(re.findall(r"sslmode=([A-Za-z-]+)", self.sh))
        self.assertEqual(modes, {"verify-full"})
        for token in ("-verify_hostname", "-verify_return_error", '-CAfile "$CA"', 'PGSSLROOTCERT="$CA"', "PGGSSENCMODE=disable"):
            self.assertIn(token, self.sh)
        self.assertNotRegex(self.sh, r"sslrootcert=system|PGSSLROOTCERT=system")

    def test_password_never_in_argv_or_logs(self):
        for line in self.sh.splitlines():
            if "DBPW" not in line:
                continue
            if line.lstrip().startswith("#"):
                continue
            allowed = [
                r'^\s*DBPW=""\s*$', r'unset DBPW', r'read -rsp "Database password', r'\[\[ -n "\$DBPW" \]\]',
                r'^\s*PGPASSWORD="\$DBPW" psql ', r'\[\[ "\$c" == \*"\$DBPW"\* \]\]',
            ]
            self.assertTrue(any(re.search(a, line) for a in allowed), "unexpected use of the password variable: " + line)
        for bad in ("export PGPASSWORD", "--password", " -W ", "echo \"$DBPW\"", "PGPASSWORD=$"):
            self.assertNotIn(bad, self.sh)
        # No process substitution and no /dev/fd anywhere: the password never travels through a pipe.
        self.assertNotIn("<(", self.sh)
        self.assertNotIn("/dev/fd", self.sh)

    def test_password_check_is_in_process_and_clears_before_redaction(self):
        body = lambda name: re.search(r"^%s\(\) \{\n(.*?)^\}" % name, self.sh, re.S | re.M).group(1)
        leak = body("leak_check_and_clear")
        self.assertIn('IFS= read -r -d \'\' c < "$f"', leak)           # bash builtin read: no helper process
        self.assertIn('[[ "$c" == *"$DBPW"* ]]', leak)                  # bash pattern match: no helper process, no pipe
        self.assertIsNotNone(re.search(r'^  DBPW=""$', leak, re.M))
        self.assertNotRegex(leak, r"\b(grep|perl|sed|printf|echo)\b[^\n]*DBPW")
        for fn in ("redact_and_scan", "finish", "redact", "scan_file"):
            self.assertNotIn("DBPW", body(fn), fn + " must never touch the password")
        # the variable is cleared right after psql exits, before any note/redaction step
        self.assertRegex(self.sh, r'wait "\$CHILD_PID" \|\| rc=\$\?\n  CHILD_PID=""\n  leak_check_and_clear\n')

    def test_output_directory_creation_is_collision_safe(self):
        self.assertRegex(self.sh, r'mktemp -d "\$HOME/forgestudio-7b-gap1-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.XXXXXXXX"')
        self.assertNotRegex(self.sh, r'OUT="\$HOME/')                        # no predictable name assigned directly
        self.assertNotRegex(self.sh, r'mkdir -p "\$OUT"\n')                  # the run directory is never created with mkdir -p
        order = [self.sh.index(s) for s in ('! -L "$run_dir"', 'existing_entries=("$run_dir"/*)', 'chmod 700 "$run_dir"', 'OUT="$run_dir"')]
        self.assertEqual(order, sorted(order))                                # every check precedes use; OUT is assigned last
        self.assertIn("shopt -s nullglob dotglob", self.sh)                   # hidden entries count as content
        self.assertLess(self.sh.index('OUT=""'), self.sh.index("trap on_exit EXIT"))   # a rejected directory is never touched by the exit handler

    def test_exit_code_semantics_are_declared_and_guarded(self):
        self.assertRegex(self.sh, r"finish 50\b")
        self.assertIn("FINAL=51", self.sh)
        self.assertRegex(self.sh, r'code=52')
        for line in ("#  50  CANCELLED", "#  51  INVENTORY NOT RUN", "#   0  success"):
            self.assertIn(line, self.sh)
        self.assertNotRegex(self.sh, r"\|\| \{ note \"[^\"]*declined[^\"]*\"; finish 0")
        self.assertNotIn("finish 0", self.sh)

    def test_tls_evidence_is_labelled(self):
        self.assertIn("INFORMATIONAL ONLY", self.sh)
        self.assertIn("AUTHORITATIVE TLS RESULT: ESTABLISHED", self.sh)
        self.assertIn("AUTHORITATIVE TLS RESULT: NOT ESTABLISHED", self.sh)
        self.assertNotIn("certificate and hostname verified", self.sh)
        self.assertIn('"${PGSSLMINPROTOCOLVERSION:-}" == "TLSv1.2"', self.sh)
        self.assertIn('read -rsp "Database password', self.sh)
        self.assertRegex(self.sh, r"case \"\$-\" in \*x\*\)")

    def test_signal_traps_and_cleanup(self):
        for sig, code in (("HUP", 129), ("INT", 130), ("QUIT", 131), ("TERM", 143)):
            self.assertIn("trap 'exit %d' %s" % (code, sig), self.sh)
        self.assertIn("trap on_exit EXIT", self.sh)

    def test_inventory_sql_is_whitelisted_read_only(self):
        stmts, meta, bodies = sql_statements(self.sql)
        self.assertEqual(stmts[0].lower(), "begin read only")
        self.assertEqual(stmts[-1].lower(), "rollback")
        self.assertEqual(len(bodies), 1)
        self.assertIn("raise exception 'GAP1_GATE_FAILED", bodies[0])
        dos = [s for s in stmts if s.lower().startswith("do ")]
        self.assertEqual(len(dos), 1)
        forbidden = re.compile(r"\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|copy|call|vacuum|analyze|reindex|cluster|refresh|lock|commit|prepare|execute|listen|notify|reset)\b|\bset\s+(local|session|role|transaction)\b", re.I)
        funcs = re.compile(r"set_config|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|lo_import|lo_export|pg_read_file|pg_ls_dir|dblink|pg_advisory", re.I)
        for s in stmts:
            first = s.split()[0].lower()
            self.assertIn(first, {"begin", "select", "rollback", "do"}, s)
            if first == "do":
                continue
            bare = re.sub(r"'(?:[^']|'')*'", "''", s)          # string literals such as 'CREATE' are arguments, not statements
            self.assertIsNone(forbidden.search(bare), "forbidden keyword in: " + s)
            self.assertIsNone(funcs.search(s), "state-changing function in: " + s)
        allowed_meta = re.compile(r"^\\(set|pset|echo|conninfo|if|else|endif|gset)\b")
        for m in meta:
            self.assertRegex(m, allowed_meta, m)
        joined = "\n".join(meta)
        self.assertNotRegex(joined, r"\\(q|quit)\b")
        self.assertLess(self.sql.index("\\set ON_ERROR_STOP on"), self.sql.index("begin read only;"))
        self.assertIn("GAP1_GATE_OK", self.sql)
        self.assertTrue(self.sql.rstrip().endswith("\\echo GAP1_INVENTORY_COMPLETE"))

    def test_no_user_rows_or_hashes_selected(self):
        self.assertNotRegex(self.sql, r"pg_authid|rolpassword|pg_shadow|usesysid")
        for t in re.findall(r"\bfrom\s+([a-z_\.]+)", self.sql, re.I):
            self.assertRegex(t, r"^(pg_[a-z_]+|information_schema\.[a-z_]+)$", t)

# ------------------------------------------------------------------ real-psql tests on a socket-only local server
def find_pg_bin():
    cand = [os.environ["GAP1_PG_BIN"]] if os.environ.get("GAP1_PG_BIN") else sorted(glob.glob("/usr/lib/postgresql/*/bin"), key=lambda p: int(p.split("/")[-2]), reverse=True)
    for c in cand:
        if os.path.exists(os.path.join(c, "postgres")):
            return c
    return None

PGBIN = find_pg_bin()

def as_pg(cmd):
    if os.geteuid() == 0:
        return ["su", "postgres", "-s", "/bin/bash", "-c", " ".join(shlex.quote(c) for c in cmd)]
    return cmd

@unittest.skipUnless(PGBIN, "no local PostgreSQL available")
class SqlRuntimeTests(unittest.TestCase):
    """LOCAL ONLY. Runs on the local PostgreSQL major version printed in the final banner."""
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="gap1-pg-", dir=SCRATCH)
        os.chmod(cls.dir, 0o755)
        if os.geteuid() == 0:
            shutil.chown(cls.dir, "postgres")
        cls.sock, cls.port = cls.dir, "55441"
        v = subprocess.run([os.path.join(PGBIN, "postgres"), "--version"], capture_output=True, text=True).stdout
        RAN["pg_major"] = int(re.search(r"(\d+)(?:\.\d+)?", v.split()[-1]).group(1))
        subprocess.run(as_pg([os.path.join(PGBIN, "initdb"), "-D", cls.dir + "/data", "-A", "trust"]), check=True, capture_output=True)
        subprocess.run(as_pg([os.path.join(PGBIN, "pg_ctl"), "-D", cls.dir + "/data", "-w", "-l", cls.dir + "/log",
                              "-o", "-p %s -k %s -c listen_addresses=''" % (cls.port, cls.dir), "start"]), check=True, capture_output=True)
        setup = """
          create role anon; create role authenticated; create role pgx login bypassrls;
          create table public.projects(id int); alter table public.projects enable row level security;
          create sequence public.s1; create function public.rls_auto_enable() returns event_trigger language plpgsql as 'begin end';
          create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();
          create schema auth; create table auth.users(id int);
        """
        cls.psql_su(["-c", setup])
        cls.before = cls.count_objects()

    @classmethod
    def tearDownClass(cls):
        subprocess.run(as_pg([os.path.join(PGBIN, "pg_ctl"), "-D", cls.dir + "/data", "-m", "fast", "stop"]), capture_output=True)
        shutil.rmtree(cls.dir, ignore_errors=True)

    @classmethod
    def psql_su(cls, args):
        r = subprocess.run([os.path.join(PGBIN, "psql"), "-X", "-w", "-h", cls.sock, "-p", cls.port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"] + args,
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return r.stdout

    @classmethod
    def count_objects(cls):
        return cls.psql_su(["-At", "-c", "select (select count(*) from pg_class), (select count(*) from pg_event_trigger), (select count(*) from pg_namespace)"]).strip()

    def run_inventory(self, sql_path=SQLF, cli_on_error_stop=False):
        args = [os.path.join(PGBIN, "psql"), "-X", "-w", "-h", self.sock, "-p", self.port, "-U", "pgx", "-d", "postgres"]
        if cli_on_error_stop:
            args += ["-v", "ON_ERROR_STOP=1"]
        return subprocess.run(args + ["-f", sql_path], capture_output=True, text=True)

    def variant(self, old, new):
        t = read(SQLF)
        self.assertIn(old, t)
        p = os.path.join(self.dir, "variant.sql")
        with open(p, "w") as f:
            f.write(t.replace(old, new, 1))
        return p

    def test_success_path_markers_and_sections(self):
        r = self.run_inventory(cli_on_error_stop=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.splitlines()
        self.assertIn("GAP1_GATE_OK", lines)
        self.assertEqual(lines[-1], "GAP1_INVENTORY_COMPLETE")
        heads = re.findall(r"^== (S\d+) ", r.stdout, re.M)
        self.assertEqual(heads, ["S%d" % i for i in range(16)])
        self.assertRegex(r.stdout, r"transaction_read_only \| on")
        self.assertRegex(r.stdout, r"PUBLIC\s+\| USAGE")          # S9 default schema ACL entry
        self.assertIn("ensure_rls", r.stdout)                      # S13
        # S15: the fixture role has no USAGE on schema auth. The inventory must still complete (a name-resolution error would abort it).
        self.assertRegex(r.stdout, r"auth\.users\s+\| t\s+\| f")
        self.assertRegex(r.stdout, r"storage\.objects\s+\| f")

    def test_success_path_without_cli_flag_and_nothing_changed(self):
        r = self.run_inventory(cli_on_error_stop=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.count_objects(), self.before)

    def test_safety_gate_failure_exits_nonzero_and_stops_output(self):
        # The gate is made to fail by running the same file with a READ WRITE transaction instead of READ ONLY.
        p = self.variant("begin read only;", "begin;")
        for flag in (False, True):
            r = self.run_inventory(p, cli_on_error_stop=flag)
            self.assertEqual(r.returncode, 3, "psql documents exit status 3 for a script error under ON_ERROR_STOP; got %s" % r.returncode)
            self.assertIn("GAP1_GATE_FAILED", r.stderr)
            self.assertNotIn("GAP1_GATE_OK", r.stdout)
            self.assertNotIn("== S0", r.stdout)
            self.assertNotIn("GAP1_INVENTORY_COMPLETE", r.stdout)

    def test_gate_variable_unset_also_fails_closed(self):
        # If the gate query returned NULL, \gset leaves the variable unset; the gate must still fail.
        p = self.variant("select (current_setting('transaction_read_only') = 'on')::text as ro \\gset",
                         "select null::text as ro \\gset")
        r = self.run_inventory(p)
        self.assertEqual(r.returncode, 3)
        self.assertIn("GAP1_GATE_FAILED", r.stderr)

    def test_quit_would_have_exited_zero_which_is_why_it_is_not_used(self):
        p = os.path.join(self.dir, "quit.sql")
        with open(p, "w") as f:
            f.write("\\echo before\n\\quit\n\\echo after\n")
        r = self.run_inventory(p, cli_on_error_stop=True)
        self.assertEqual(r.returncode, 0)

    def test_write_attempt_is_refused_by_the_server(self):
        p = self.variant("rollback;\n\\echo GAP1_INVENTORY_COMPLETE", "create table public.gap1_should_fail(x int);\nrollback;\n\\echo GAP1_INVENTORY_COMPLETE")
        r = self.run_inventory(p)
        self.assertEqual(r.returncode, 3)
        self.assertIn("read-only transaction", r.stderr)
        self.assertNotIn("GAP1_INVENTORY_COMPLETE", r.stdout)
        self.assertEqual(self.count_objects(), self.before)

    def test_every_catalog_column_used_exists(self):
        wanted = {
            "pg_roles": "rolname rolsuper rolinherit rolcreaterole rolcreatedb rolcanlogin rolreplication rolbypassrls rolconnlimit rolvaliduntil rolconfig oid".split(),
            "pg_auth_members": "roleid member grantor admin_option inherit_option set_option".split(),
            "pg_stat_ssl": "pid ssl version cipher bits".split(),
            "pg_namespace": "nspname nspowner nspacl oid".split(),
            "pg_default_acl": "defaclrole defaclnamespace defaclobjtype defaclacl".split(),
            "pg_class": "relname relnamespace relowner relkind relrowsecurity oid".split(),
            "pg_proc": "oid pronamespace proowner prosecdef".split(),
            "pg_event_trigger": "evtname evtevent evtowner evtenabled".split(),
            "pg_extension": "extname extversion".split(),
            "pg_settings": "name setting".split(),
        }
        for rel, cols in wanted.items():
            out = self.psql_su(["-At", "-c", "select attname from pg_attribute where attrelid = 'pg_catalog.%s'::regclass and attnum > 0 and not attisdropped" % rel])
            have = set(out.split())
            for c in cols:
                self.assertIn(c, have, "%s.%s missing" % (rel, c))

# ------------------------------------------------------------------
# real TCP/TLS integration tests: local PostgreSQL only, never Supabase
@unittest.skipUnless(PGBIN and shutil.which("openssl"), "local PostgreSQL and OpenSSL are required")
class LocalTlsIntegrationTests(unittest.TestCase):
    """Uses real libpq/psql TLS against an isolated localhost PostgreSQL server.

    This proves CA-chain and hostname verification against a locally generated CA.
    It does not contact Supabase or validate Supabase's real certificate/endpoint.
    """
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="gap1-local-tls-", dir=SCRATCH)
        os.chmod(cls.root, 0o755)
        if os.geteuid() == 0:
            shutil.chown(cls.root, "postgres")
        cls.data = os.path.join(cls.root, "data")
        cls.sockdir = os.path.join(cls.root, "sock")
        os.makedirs(cls.sockdir, mode=0o755)
        if os.geteuid() == 0:
            shutil.chown(cls.sockdir, "postgres")
        # Pick a currently unused TCP port; this server binds only to loopback.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            cls.port = probe.getsockname()[1]
        cls.ca = os.path.join(cls.root, "test-ca.crt")
        ca_key = os.path.join(cls.root, "test-ca.key")
        server_key = os.path.join(cls.root, "server.key")
        csr = os.path.join(cls.root, "server.csr")
        server_crt = os.path.join(cls.root, "server.crt")
        san = os.path.join(cls.root, "server-ext.cnf")
        with open(san, "w", encoding="utf-8") as f:
            f.write("subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n")
        openssl = shutil.which("openssl")
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", ca_key, "-out", cls.ca, "-subj", "/CN=GAP1 local test CA",
                        "-days", "2", "-sha256"], check=True, capture_output=True, text=True)
        subprocess.run([openssl, "req", "-new", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", server_key, "-out", csr, "-subj", "/CN=localhost"],
                       check=True, capture_output=True, text=True)
        subprocess.run([openssl, "x509", "-req", "-in", csr, "-CA", cls.ca, "-CAkey", ca_key,
                        "-CAcreateserial", "-out", server_crt, "-days", "2", "-sha256",
                        "-extfile", san], check=True, capture_output=True, text=True)
        subprocess.run(as_pg([os.path.join(PGBIN, "initdb"), "-D", cls.data, "-A", "trust"]),
                       check=True, capture_output=True)
        # Install the server key/cert where the postgres OS account can read them.
        for src, name, mode in ((server_crt, "server.crt", 0o644), (server_key, "server.key", 0o600)):
            dst = os.path.join(cls.data, name)
            shutil.copyfile(src, dst)
            os.chmod(dst, mode)
            if os.geteuid() == 0:
                shutil.chown(dst, "postgres")
        with open(os.path.join(cls.data, "postgresql.conf"), "a", encoding="utf-8") as f:
            f.write("\nlisten_addresses='127.0.0.1'\nport=%d\nunix_socket_directories='%s'\nssl=on\nssl_cert_file='server.crt'\nssl_key_file='server.key'\n" %
                    (cls.port, cls.sockdir.replace("'", "''")))
        subprocess.run(as_pg([os.path.join(PGBIN, "pg_ctl"), "-D", cls.data, "-w", "-l",
                              os.path.join(cls.root, "postgres.log"), "start"]),
                       check=True, capture_output=True, text=True)
        cls.env_base = os.environ.copy()
        for key in ("PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGSSLCERT", "PGSSLKEY",
                    "PGSSLROOTCERT", "PGSSLMODE", "PGHOSTADDR", "PGPASSWORD"):
            cls.env_base.pop(key, None)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "data") and os.path.isdir(cls.data):
            subprocess.run(as_pg([os.path.join(PGBIN, "pg_ctl"), "-D", cls.data, "-m", "fast", "stop"]),
                           capture_output=True, text=True)
        if hasattr(cls, "root"):
            shutil.rmtree(cls.root, ignore_errors=True)

    def psql(self, host="localhost", ca=None):
        env = self.env_base.copy()
        env.update({"PGHOST": host, "PGPORT": str(self.port), "PGDATABASE": "postgres",
                    "PGUSER": "postgres", "PGSSLMODE": "verify-full",
                    "PGSSLROOTCERT": ca or self.ca, "PGSSLMINPROTOCOLVERSION": "TLSv1.2",
                    "PGGSSENCMODE": "disable", "PGCONNECT_TIMEOUT": "5"})
        return subprocess.run([os.path.join(PGBIN, "psql"), "-X", "-w", "-v", "ON_ERROR_STOP=1",
                               "-At", "-c",
                               "select case when ssl then 't' else 'f' end || '|' || version from pg_stat_ssl where pid=pg_backend_pid()"],
                              env=env, capture_output=True, text=True, timeout=15)

    def test_real_tls_connection_succeeds_with_trusted_ca_and_matching_hostname(self):
        r = self.psql()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stdout.strip(), r"^t\|TLSv1\.[23]$")
        self.assertNotIn("certificate verify failed", r.stderr.lower())

    def test_real_tls_connection_rejects_wrong_ca(self):
        decoy = os.path.join(self.root, "decoy-ca.crt")
        key = os.path.join(self.root, "decoy-ca.key")
        subprocess.run([shutil.which("openssl"), "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", key, "-out", decoy, "-subj", "/CN=GAP1 decoy CA",
                        "-days", "2", "-sha256"], check=True, capture_output=True)
        r = self.psql(ca=decoy)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stderr.lower(), r"certificate verify failed|self[- ]signed|unable to get local issuer")

    def test_real_tls_connection_rejects_hostname_mismatch(self):
        r = self.psql(host="127.0.0.1")
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stderr.lower(), r"hostname mismatch|does not match|certificate.*match|server certificate")

# ------------------------------------------------------------------ script-flow tests (pty, stubbed psql and s_client)
STUB_PSQL = r'''#!/bin/bash
echo "psql $*" >> "$STUB_LOG"
echo "ENV PGSSLMODE=${PGSSLMODE-} PGSSLROOTCERT=${PGSSLROOTCERT-} PGGSSENCMODE=${PGGSSENCMODE-} MINPROTO=${PGSSLMINPROTOCOLVERSION-} PGPASSWORD_SET=${PGPASSWORD:+yes}" >> "$STUB_LOG"
if [[ "$1" == "--version" ]]; then echo "psql (PostgreSQL) ${STUB_PSQL_VERSION:-17.6}"; exit 0; fi
mode=""
for a in "$@"; do [[ "$a" == "-c" ]] && mode=ca; [[ "$a" == "-f" ]] && mode=inv; done
if [[ "$mode" == ca ]]; then
  case "${STUB_CA_MODE:-certfail}" in
    success) printf '?column?\n1\n'; exit 0;;
    certfail) echo "psql: error: connection to server at \"$PGHOST\" (203.0.113.9), port 5432 failed: SSL error: certificate verify failed" >&2; exit 2;;
    neterr) echo "psql: error: connection to server at \"$PGHOST\", port 5432 failed: Connection timed out" >&2; exit 2;;
  esac
fi
if [[ "$mode" == inv ]]; then
  body() {
    echo "== S1 client-side TLS =="
    echo "You are connected to database \"postgres\" as user \"$PGUSER\" on host \"$PGHOST\" (address \"203.0.113.9\") at port \"5432\"."
    echo "SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)"
    echo "home was $HOME/forgestudio"
  }
  case "${STUB_INV_MODE:-ok}" in
    ok) echo GAP1_GATE_OK; body; echo GAP1_INVENTORY_COMPLETE; exit 0;;
    gatefail) echo "psql:gap1-inventory.sql:20: ERROR:  GAP1_GATE_FAILED: transaction is not read-only" >&2; exit 3;;
    nogate) body; echo GAP1_INVENTORY_COMPLETE; exit 0;;
    nocomplete) echo GAP1_GATE_OK; body; exit 0;;
    token) echo GAP1_GATE_OK; body; echo "abcdefghijklmnopqrstuvwxyz0123456789ABCD"; echo GAP1_INVENTORY_COMPLETE; exit 0;;
    leak) echo GAP1_GATE_OK; body; echo "debug value $PGPASSWORD"; echo GAP1_INVENTORY_COMPLETE; exit 0;;
    leakerr) echo GAP1_GATE_OK; body; echo GAP1_INVENTORY_COMPLETE; echo "debug value $PGPASSWORD" >&2; exit 0;;
    hang) echo $$ > "$STUB_PIDFILE"; : > "$STUB_MARK"; exec sleep 60;;
  esac
fi
exit 0
'''
STUB_OPENSSL = r'''#!/bin/bash
echo "openssl $*" >> "$STUB_LOG"
echo "ENV PGPASSWORD_SET=${PGPASSWORD:+yes}" >> "$STUB_LOG"
case "$1" in
  s_client)
    if [[ "${STUB_SCLIENT_MODE:-ok}" == fail ]]; then echo "verify error:num=18:handshake not supported by this server"; exit 1; fi
    echo "CONNECTION ESTABLISHED"; echo "Verification: OK"; exit 0;;
  *) exec @REAL_OPENSSL@ "$@";;
esac
'''
# mktemp stub: "real" delegates to the real mktemp; the other modes simulate a failure or a collision (an existing directory returned).
STUB_MKTEMP = r'''#!/bin/bash
echo "mktemp $*" >> "$STUB_LOG"
case "${STUB_MKTEMP_MODE:-real}" in
  real) exec @REAL@ "$@";;
  fail) echo "mktemp: simulated failure" >&2; exit 1;;
  target) echo "$STUB_MKTEMP_TARGET"; exit 0;;
esac
'''
# date stub: a fixed value makes two runs produce the same timestamp, so only the random suffix can keep their directories apart.
STUB_DATE = r'''#!/bin/bash
if [[ -n "${STUB_FIXED_DATE:-}" ]]; then echo "$STUB_FIXED_DATE"; exit 0; fi
exec @REAL@ "$@"
'''
# Logging wrappers: every helper process the script starts is recorded (argv and whether it received the password variable).
STUB_WRAP = r'''#!/bin/bash
echo "tool @NAME@ $*" >> "$STUB_LOG"
echo "TOOLENV PGPASSWORD_SET=${PGPASSWORD:+yes}" >> "$STUB_LOG"
exec @REAL@ "$@"
'''

class FlowResult:
    pass

class ScriptFlowTests(unittest.TestCase):
    """LOCAL ONLY. These tests stub psql/OpenSSL to exercise prompt/error/redaction control flow; real TLS behavior is tested separately by LocalTlsIntegrationTests. They never connect to Supabase."""
    def setUp(self):
        self.td = tempfile.mkdtemp(prefix="gap1-flow-", dir=SCRATCH)
        self.home = os.path.join(self.td, "home")
        os.makedirs(self.home)
        tools, stubs = os.path.join(self.td, "tools"), os.path.join(self.td, "stubs")
        os.makedirs(tools); os.makedirs(stubs)
        for t in ["bash", "env", "sed", "grep", "perl", "id", "date", "mkdir", "mktemp", "chmod", "mv", "rm", "cat", "tee", "head", "tr", "dirname", "stty", "sleep", "touch", "timeout"]:
            p = shutil.which(t)
            if p:
                os.symlink(p, os.path.join(tools, t))
        real_openssl = shutil.which("openssl")
        bodies = [("psql", STUB_PSQL), ("openssl", STUB_OPENSSL.replace("@REAL_OPENSSL@", real_openssl))]
        for tool in ("grep", "perl", "sed"):
            bodies.append((tool, STUB_WRAP.replace("@NAME@", tool).replace("@REAL@", shutil.which(tool))))
        bodies.append(("mktemp", STUB_MKTEMP.replace("@REAL@", shutil.which("mktemp"))))
        bodies.append(("date", STUB_DATE.replace("@REAL@", shutil.which("date"))))
        for name, body in bodies:
            p = os.path.join(stubs, name)
            with open(p, "w") as f:
                f.write(body)
            os.chmod(p, 0o755)
        self.path = stubs + ":" + tools
        self.log = os.path.join(self.td, "stub.log")
        self.mark, self.pidfile = os.path.join(self.td, "mark"), os.path.join(self.td, "pid")
        self.ca = os.path.join(self.td, "ca.crt")
        subprocess.run([real_openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", os.path.join(self.td, "k.pem"), "-out", self.ca,
                        "-subj", "/CN=gap1-test-ca", "-days", "2"], check=True, capture_output=True)
        os.remove(os.path.join(self.td, "k.pem"))

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def env(self, **kw):
        e = {"HOME": self.home, "PATH": self.path, "TERM": "dumb", "LANG": "C", "STUB_LOG": self.log, "STUB_MARK": self.mark, "STUB_PIDFILE": self.pidfile}
        e.update({k: str(v) for k, v in kw.items()})
        return e

    def run_script(self, host=HOST, ref=REF, ca=None, ca_mode="certfail", inv_mode="ok", net="y", step3="y", password=PASSWORD,
                   argv=None, extra_env=None, sig=None):
        env = self.env(STUB_CA_MODE=ca_mode, STUB_INV_MODE=inv_mode, **(extra_env or {}))
        replies = [("Pooler host", host), ("Project ref", ref), ("Path to the Supabase CA", ca or self.ca), ("Continue?", net),
                   ("Step 3:", step3), ("Database password", password)]
        pid, fd = pty.fork()
        if pid == 0:
            os.execve("/bin/bash", argv or ["bash", SCRIPT], env)
        buf, idx, scanned, sent_sig, deadline = "", 0, 0, False, time.time() + 90
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if sig and not sent_sig and os.path.exists(self.mark):
                os.kill(pid, sig); sent_sig = True
            if not r:
                continue
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            buf += data.decode(errors="replace")
            if idx < len(replies) and replies[idx][0] in buf[scanned:]:
                os.write(fd, (replies[idx][1] + "\n").encode())
                scanned = len(buf); idx += 1
        _, status = os.waitpid(pid, 0)
        res = FlowResult()
        res.rc = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
        res.out = buf
        res.dirs = glob.glob(os.path.join(self.home, "forgestudio-7b-gap1-*"))
        res.dir = res.dirs[0] if res.dirs else None
        res.log = read(self.log) if os.path.exists(self.log) else ""
        res.files = {}
        if res.dir:
            for root, _, names in os.walk(res.dir):
                for n in names:
                    p = os.path.join(root, n)
                    with open(p, "rb") as f:
                        res.files[os.path.relpath(p, res.dir)] = f.read().decode(errors="replace")
        return res

    def assertNoSecret(self, res):
        self.assertNotIn(PASSWORD, res.out)
        self.assertNotIn(PASSWORD, res.log, "password reached an argv or a log")
        for name, text in res.files.items():
            if name.startswith("0") and name.endswith((".txt", ".err")) and ".redacted." not in name and self._leak_expected:
                continue                                              # a deliberately leaking stub wrote the value into its own raw output
            self.assertNotIn(PASSWORD, text, name)

    _leak_expected = False

    def assertNoPasswordInHelpers(self, res):
        """No helper process (grep, perl, sed, openssl) received the password variable, an argument containing it, or a /dev/fd pipe."""
        tool_lines = [l for l in res.log.splitlines() if l.startswith(("tool ", "openssl "))]
        self.assertTrue(any(l.startswith("tool grep") for l in tool_lines))
        self.assertTrue(any(l.startswith("tool perl") for l in tool_lines))
        for l in tool_lines:
            self.assertNotIn(PASSWORD, l)
            self.assertNotIn("/dev/fd", l)
        self.assertNotIn("TOOLENV PGPASSWORD_SET=yes", res.log)

    def summary_says_tls_established(self, res):
        return "AUTHORITATIVE TLS RESULT: ESTABLISHED" in res.files.get("00-summary.txt", "")

    def redacted(self, res):
        return {n: t for n, t in res.files.items() if ".redacted." in n and not n.startswith("blocked/")}

    # ---- success path
    def test_success_path_exit0_redaction_and_no_secret_leak(self):
        res = self.run_script(extra_env={"PGSSLMODE": "require", "PGGSSENCMODE": "prefer", "PGSSLROOTCERT": "/etc/passwd", "PGOPTIONS": "-c x=1", "PGPASSWORD": "from-parent-env"})
        self.assertEqual(res.rc, 0, res.out[-2000:])
        self.assertIn("step 2b wrong-CA test: PASS", res.out)
        self.assertIn("step 3 inventory: PASS", res.out)
        red = self.redacted(res)
        self.assertTrue(any(n.startswith("03-inventory.redacted") for n in red), list(res.files))
        for n, t in red.items():
            for secret in (HOST, REF, self.home):
                self.assertNotIn(secret, t, n)
        inv = red["03-inventory.redacted.txt"]
        for tag in ("<pooler-host>", "<project-ref>", "<ip>", "<home>"):
            self.assertIn(tag, inv)
        self.assertIn("Fingerprint=", red["01-local-checks.redacted.txt"])      # public fingerprint must survive redaction
        self.assertIn("REVIEW-REQUIRED.txt", res.files)
        self.assertIn("sensitive variables cleared (exit 0)", res.files["cleanup.log"])
        self.assertNoSecret(res)
        self.assertNotIn("from-parent-env", res.log)
        self.assertNotIn("/etc/passwd", res.log)
        self.assertNoPasswordInHelpers(res)
        summary = res.files["00-summary.txt"]
        for must in ("step 2b wrong-CA test: PASS", "step 3 inventory: PASS", "AUTHORITATIVE TLS RESULT: ESTABLISHED"):
            self.assertIn(must, summary)
        self.assertIn("INFORMATIONAL ONLY", summary)

    def test_tls_settings_are_enforced_on_every_connection(self):
        res = self.run_script(extra_env={"PGSSLMODE": "require", "PGGSSENCMODE": "prefer", "PGSSLROOTCERT": "/etc/passwd"})
        self.assertEqual(res.rc, 0)
        envs = re.findall(r"^ENV PGSSLMODE=(\S*) PGSSLROOTCERT=(\S*) PGGSSENCMODE=(\S*) MINPROTO=(\S*) PGPASSWORD_SET=(\S*)", res.log, re.M)
        self.assertGreaterEqual(len(envs), 3)                       # version, wrong-CA test, inventory
        for mode, root, gss, minp, _ in envs:
            self.assertEqual(mode, "verify-full")
            self.assertEqual(gss, "disable")
            self.assertEqual(minp, "TLSv1.2")
        self.assertEqual(envs[-1][1], self.ca)                       # the inventory used exactly the specified CA
        self.assertTrue(any(r != self.ca and r.endswith("decoy-ca.crt") for _, r, _, _, _ in envs))   # the wrong-CA test used only the decoy
        s_client = [l for l in res.log.splitlines() if l.startswith("openssl s_client")][0]
        for tok in ("-verify_hostname " + HOST, "-verify_return_error", "-CAfile " + self.ca, "-starttls postgres"):
            self.assertIn(tok, s_client)
        # the password variable reaches only the inventory psql process
        pw_flags = re.findall(r"PGPASSWORD_SET=(\S*)", res.log)
        self.assertEqual(pw_flags.count("yes"), 1)
        self.assertEqual(envs[-1][4], "yes")

    # ---- wrong-CA test fails closed
    def test_wrong_ca_unexpected_success_stops_before_password(self):
        res = self.run_script(ca_mode="success")
        self.assertEqual(res.rc, 20)
        self.assertIn("FAIL - the connection SUCCEEDED with a wrong CA", res.out)
        self.assertNotIn("Database password", res.out)
        self.assertNotIn("-f ", " ".join(l for l in res.log.splitlines() if l.startswith("psql ")))
        self.assertNoSecret(res)

    def test_wrong_ca_inconclusive_stops(self):
        res = self.run_script(ca_mode="neterr")
        self.assertEqual(res.rc, 21)
        self.assertIn("INCONCLUSIVE", res.out)
        self.assertNotIn("Database password", res.out)

    # ---- inventory / safety-gate failure is detected by the caller
    def test_gate_failure_status_is_detected(self):
        res = self.run_script(inv_mode="gatefail")
        self.assertEqual(res.rc, 40)
        self.assertIn("the read-only safety gate failed", res.out)
        self.assertNotIn("step 3 inventory: PASS", res.out)
        self.assertNoSecret(res)

    def test_missing_markers_with_exit0_is_failure(self):
        for mode in ("nogate", "nocomplete"):
            self.tearDown(); self.setUp()
            res = self.run_script(inv_mode=mode)
            self.assertEqual(res.rc, 41, mode)
            self.assertIn("success markers are missing", res.out)

    # ---- redaction stop
    def test_suspicious_leftover_stops_and_quarantines(self):
        res = self.run_script(inv_mode="token")
        self.assertEqual(res.rc, 30)
        self.assertIn("STOP: suspicious content remains", res.out)
        self.assertIn("long-token", res.out)
        self.assertEqual(self.redacted(res), {})
        self.assertTrue(any(n.startswith("blocked/") for n in res.files))
        self.assertNotIn("REVIEW-REQUIRED.txt", res.files)

    def test_password_value_in_output_stops_with_31(self):
        res = self.run_script(inv_mode="leak")
        self.assertEqual(res.rc, 31)
        self.assertEqual(self.redacted(res), {})
        self.assertIn("password-value", res.out)

    # ---- password cleanup on signals
    def _signal_case(self, sig, code):
        res = self.run_script(inv_mode="hang", sig=sig)
        self.assertEqual(res.rc, code)
        self.assertIn("sensitive variables cleared (exit %d)" % code, res.files.get("cleanup.log", ""))
        time.sleep(0.5)
        pid = int(read(self.pidfile).strip())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)                                          # the psql child was terminated
        self.assertNoSecret(res)

    def test_sigterm_clears_password_and_stops_child(self):
        self._signal_case(signal.SIGTERM, 143)

    def test_sigint_clears_password_and_stops_child(self):
        self._signal_case(signal.SIGINT, 130)

    # ---- refusals
    def test_refuses_xtrace(self):
        res = self.run_script(argv=["bash", "-x", SCRIPT])
        self.assertEqual(res.rc, 2)
        self.assertIn("refusing to run with xtrace", res.out)
        self.assertNotIn("Database password", res.out)

    def test_refuses_without_terminal(self):
        r = subprocess.run(["/bin/bash", SCRIPT], stdin=subprocess.DEVNULL, capture_output=True, text=True, env=self.env())
        self.assertEqual(r.returncode, 2)
        self.assertIn("interactive terminal", r.stderr)

    def test_refuses_bad_host_ref_and_ca(self):
        for kw, text in (({"host": "db.abcdefghij0123456789.supabase.co"}, "host must look like"),
                         ({"host": "evil.example.com"}, "host must look like"),
                         ({"ref": "NOT A REF"}, "project ref has an unexpected shape"),
                         ({"ca": os.path.join(self.td, "missing.crt")}, "certificate file not found")):
            self.tearDown(); self.setUp()
            res = self.run_script(**kw)
            self.assertEqual(res.rc, 2, kw)
            self.assertIn(text, res.out)
            self.assertNotIn("s_client", res.log)

    # ---- output directory: unique, private, never reused
    RUN_DIR_NAME = re.compile(r"^forgestudio-7b-gap1-\d{8}T\d{6}Z\.[A-Za-z0-9]{8}$")

    def snapshot(self, path):
        snap = {}
        for root, dirs, names in os.walk(path):
            for n in names + dirs:
                p = os.path.join(root, n)
                snap[os.path.relpath(p, path)] = (os.lstat(p).st_mode, None if os.path.isdir(p) else open(p, "rb").read())
        return snap

    def run_dirs(self):
        return sorted(glob.glob(os.path.join(self.home, "forgestudio-7b-gap1-*")))

    def test_run_directory_is_unique_private_and_never_overwritten_even_with_identical_timestamps(self):
        fixed = {"STUB_FIXED_DATE": "20260101T000000Z"}                              # both runs get the same timestamp
        a = self.run_script(net="n", extra_env=fixed)
        dir_a = a.dir
        before = self.snapshot(dir_a)
        b = self.run_script(net="n", extra_env=fixed)
        dirs = self.run_dirs()
        self.assertEqual(len(dirs), 2, dirs)
        self.assertEqual(len({os.path.basename(d) for d in dirs}), 2)
        for d in dirs:
            self.assertRegex(os.path.basename(d), self.RUN_DIR_NAME)
            self.assertTrue(os.path.basename(d).startswith("forgestudio-7b-gap1-20260101T000000Z."))
            self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700, d)
            self.assertFalse(os.path.islink(d))
            for n in os.listdir(d):
                p = os.path.join(d, n)
                if os.path.isfile(p):
                    self.assertEqual(stat.S_IMODE(os.stat(p).st_mode) & 0o077, 0, p)   # no group/other access to any output file
        self.assertEqual(self.snapshot(dir_a), before, "the second run changed the first run's directory")
        new = [d for d in dirs if d != dir_a]
        self.assertEqual(len(new), 1)
        self.assertIn("00-summary.txt", os.listdir(new[0]))                         # the second run really wrote into its own directory
        self.assertEqual(b.rc, 50)

    def test_many_runs_with_identical_timestamps_never_collide(self):
        fixed = {"STUB_FIXED_DATE": "20260101T000000Z"}
        for _ in range(8):
            self.run_script(net="n", extra_env=fixed)
        names = [os.path.basename(d) for d in self.run_dirs()]
        self.assertEqual(len(names), 8)
        self.assertEqual(len(set(names)), 8)

    def test_mktemp_failure_stops_before_any_input_or_output(self):
        res = self.run_script(extra_env={"STUB_MKTEMP_MODE": "fail"})
        self.assertEqual(res.rc, 2)
        self.assertIn("could not create a unique output directory", res.out)
        self.assertNotIn("Pooler host", res.out)
        self.assertEqual(self.run_dirs(), [])
        self.assertNoSecret(res)

    def _collision(self, make_target, message, check_untouched):
        target = make_target()
        before = self.snapshot(self.home)
        res = self.run_script(extra_env={"STUB_MKTEMP_MODE": "target", "STUB_MKTEMP_TARGET": target})
        self.assertEqual(res.rc, 2, res.out[-500:])
        self.assertIn(message, res.out)
        self.assertNotIn("Pooler host", res.out)
        self.assertEqual(self.snapshot(self.home), before, "a rejected directory (or anything else in HOME) was modified")
        check_untouched()
        self.assertEqual(self.run_dirs(), [])

    def test_existing_nonempty_directory_is_refused_and_left_untouched(self):
        target = os.path.join(self.home, "collision-target")
        def make():
            os.makedirs(target); os.chmod(target, 0o755)
            with open(os.path.join(target, "keep.txt"), "w") as f:
                f.write("original")
            return target
        def check():
            self.assertEqual(open(os.path.join(target, "keep.txt")).read(), "original")
            self.assertEqual(os.listdir(target), ["keep.txt"])
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o755)           # not even re-permissioned
        self._collision(make, "already has content", check)

    def test_existing_directory_with_only_hidden_content_is_refused(self):
        target = os.path.join(self.home, "collision-hidden")
        def make():
            os.makedirs(target)
            with open(os.path.join(target, ".hidden"), "w") as f:
                f.write("x")
            return target
        self._collision(make, "already has content", lambda: self.assertEqual(os.listdir(target), [".hidden"]))

    def test_symlink_as_run_directory_is_refused(self):
        real, link = os.path.join(self.home, "real-target"), os.path.join(self.home, "link-target")
        def make():
            os.makedirs(real); os.chmod(real, 0o755)
            os.symlink(real, link)
            return link
        self._collision(make, "not a real directory", lambda: (self.assertEqual(os.listdir(real), []),
                                                              self.assertEqual(stat.S_IMODE(os.stat(real).st_mode), 0o755)))

    def test_missing_directory_returned_by_mktemp_is_refused(self):
        self._collision(lambda: os.path.join(self.home, "does-not-exist"), "not a real directory", lambda: None)

    # ---- cancellation paths: never exit 0
    def test_declining_network_confirmation_is_cancelled_not_success(self):
        res = self.run_script(net="n")
        self.assertNotEqual(res.rc, 0)
        self.assertEqual(res.rc, 50)
        self.assertIn("NOT RUN: you declined the network confirmation", res.out)
        self.assertNotIn("s_client", res.log)
        psql_lines = [l for l in res.log.splitlines() if l.startswith("psql ")]
        self.assertTrue(all("--version" in l for l in psql_lines), psql_lines)       # nothing was contacted
        self.assertNotIn("Database password", res.out)
        self.assertFalse(self.summary_says_tls_established(res))
        self.assertIn("AUTHORITATIVE TLS RESULT: NOT ESTABLISHED", res.files["00-summary.txt"])
        self.assertNoSecret(res)

    def test_declining_step3_is_inventory_not_run_not_success(self):
        res = self.run_script(step3="n")
        self.assertNotEqual(res.rc, 0)
        self.assertEqual(res.rc, 51)
        self.assertIn("step 2b wrong-CA test: PASS", res.out)                          # the earlier mandatory test did run
        self.assertIn("step 3 inventory: NOT RUN", res.out)
        self.assertNotIn("Database password", res.out)
        psql_lines = [l for l in res.log.splitlines() if l.startswith("psql ")]
        self.assertFalse(any(" -f " in l for l in psql_lines))                         # the inventory never ran
        self.assertFalse(self.summary_says_tls_established(res))
        self.assertNoSecret(res)

    def test_exit_zero_only_when_everything_passed(self):
        scenarios = [dict(net="n"), dict(step3="n"), dict(ca_mode="success"), dict(ca_mode="neterr"), dict(inv_mode="gatefail"),
                     dict(inv_mode="nogate"), dict(inv_mode="nocomplete"), dict(inv_mode="token"), dict(inv_mode="leak"), dict(inv_mode="leakerr")]
        for kw in scenarios:
            self.tearDown(); self.setUp()
            self._leak_expected = kw.get("inv_mode") in ("leak", "leakerr")
            res = self.run_script(**kw)
            self.assertNotEqual(res.rc, 0, kw)
            summaries = [t for n, t in res.files.items() if n.endswith("00-summary.txt") or n.endswith("00-summary.redacted.txt")]
            self.assertTrue(all("FINAL EXIT CODE: %d " % res.rc in t for t in summaries), kw)
            if kw.get("inv_mode") in ("token", "leak", "leakerr"):
                # the connection itself verified, but redaction/leak checks failed: TLS may be reported, the run is still not a success
                self.assertIn(res.rc, (30, 31), kw)
            else:
                self.assertFalse(self.summary_says_tls_established(res), kw)
        self._leak_expected = False
        self.tearDown(); self.setUp()
        ok = self.run_script()
        self.assertEqual(ok.rc, 0)
        self.assertTrue(self.summary_says_tls_established(ok))

    # ---- TLS evidence labelling
    def test_openssl_probe_is_informational_and_not_required(self):
        res = self.run_script(extra_env={"STUB_SCLIENT_MODE": "fail"})
        self.assertEqual(res.rc, 0)                                                    # a failing probe does not decide the result
        summary = res.files["00-summary.txt"]
        self.assertIn("INFORMATIONAL ONLY", summary)
        self.assertIn("AUTHORITATIVE TLS RESULT: ESTABLISHED", summary)               # established by the psql inventory connection
        self.tearDown(); self.setUp()
        res = self.run_script(inv_mode="gatefail")                                     # probe fine, authoritative connection not completed
        self.assertEqual(res.rc, 40)
        self.assertIn("AUTHORITATIVE TLS RESULT: NOT ESTABLISHED", res.files["00-summary.txt"])
        self.assertNotIn("verified", res.files["00-summary.txt"].split("AUTHORITATIVE")[0].split("step 2 OpenSSL")[1])

    # ---- password handling
    def test_password_in_stderr_output_is_detected_in_process(self):
        self._leak_expected = True
        res = self.run_script(inv_mode="leakerr")
        self.assertEqual(res.rc, 31)
        self.assertIn("03-inventory.err: password-value", res.out)
        self.assertEqual(self.redacted(res), {})
        self.assertNoPasswordInHelpers(res)                                            # detection used no helper process

    def test_no_helper_process_ever_receives_the_password(self):
        res = self.run_script()
        self.assertEqual(res.rc, 0)
        self.assertNoPasswordInHelpers(res)
        flags = re.findall(r"^(?:ENV .*|TOOLENV) PGPASSWORD_SET=(\S*)", res.log, re.M)
        self.assertEqual(flags.count("yes"), 1)                                        # exactly one process: the inventory psql

class Banner(unittest.TextTestResult):
    pass

if __name__ == "__main__":
    runner = unittest.TextTestRunner(verbosity=2, resultclass=Banner)
    result = unittest.main(exit=False, testRunner=runner, argv=[sys.argv[0]]).result
    print("\n" + "=" * 78)
    print("SCOPE: LOCAL TESTS ONLY. Nothing was run against Supabase or production.")
    if RAN["pg_major"] is None:
        print("SQL runtime tests: NOT RUN (no local PostgreSQL)")
    elif RAN["pg_major"] == 17:
        print("SQL runtime tests: ran on a local PostgreSQL 17 (still not production)")
    else:
        print("SQL runtime tests: ran on local PostgreSQL %s. PostgreSQL 17 RUNTIME VERIFICATION: NOT RUN (see docs verification)." % RAN["pg_major"])
    print("Script-flow tests: psql and the TLS handshake were STUBS (control flow only).")
    print("=" * 78)
    sys.exit(0 if result.wasSuccessful() else 1)
