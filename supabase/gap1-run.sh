#!/usr/bin/env bash
# ForgeStudio Phase 7B, Gap 1, Step 1: READ-ONLY production TLS and role inventory.
# STATUS: PREPARED, NOT RUN against production.
#
# Run by the Commander on a local machine, from a terminal shell started with:  HISTFILE=/dev/null bash --norc
#  - No pg_dump, no pg_restore, no write, no DDL. Every network step asks for confirmation first.
#  - TLS is sslmode=verify-full with hostname verification against the CA file you supply, TLS 1.2 or newer, GSS encryption
#    disabled. There is no fallback path.
#
# TLS EVIDENCE (what counts):
#  - The AUTHORITATIVE TLS check is the psql inventory connection (step 3). libpq with verify-full fails the connection if the
#    certificate chain or hostname does not verify, so a successful inventory is the only thing that establishes verified TLS.
#  - Step 2 (the OpenSSL probe) is INFORMATIONAL ONLY. It can fail or be unsupported by the pooler and proves nothing by itself.
#  - Step 2b (wrong CA must be rejected) proves verification is enforced; it does not prove the real CA verifies.
#
# PASSWORD EXPOSURE (accurate description):
#  - Typed at a hidden prompt into one unexported shell variable. Never in an argument, a pipe, a file or a log.
#  - It is handed to the single psql process through that process's ENVIRONMENT. For the few seconds psql runs, the value is readable
#    by the same OS user and by root (for example through the process environment). This exposure is accepted and cannot be removed
#    without writing the password to disk.
#  - After psql exits, the output files are checked for the value with bash's own pattern match: in-process, no helper process and
#    no pipe. The variable is then cleared immediately, BEFORE redaction runs. It is cleared again on every exit path and on
#    HUP, INT, QUIT and TERM; a running psql child is killed first. Core dumps are disabled for this shell.
#  - Not covered: anything the operating system itself may persist (swap, a debugger, a compromised account).
#
# EXIT CODES - exit 0 means ALL of these passed: TLS settings guard, mandatory wrong-CA rejection, psql verify-full inventory
# completed with both markers, and the redaction scan. Anything else is non-zero:
#   0  success
#   2  refused to start (bad environment or input)
#  20  wrong-CA test: the connection UNEXPECTEDLY SUCCEEDED (certificate verification not enforced) - STOP
#  21  wrong-CA test inconclusive (could not prove the wrong CA is rejected) - STOP
#  30  suspicious pattern left after redaction - outputs quarantined, do not share
#  31  the password value was found in an output file - outputs quarantined, do not share
#  40  inventory failed, including the read-only safety gate (psql exited non-zero)
#  41  inventory exited 0 but the success markers are missing (treated as failure)
#  50  CANCELLED: you declined the network confirmation; nothing was contacted; NOT RUN
#  51  INVENTORY NOT RUN: you declined step 3 (the wrong-CA test had already run); NOT RUN
#  52  internal consistency failure (success flags missing); treated as failure
# 129/130/131/143  interrupted by HUP/INT/QUIT/TERM (password cleared first)
set -Eeuo pipefail
case "$-" in *x*) echo "ERROR: refusing to run with xtrace (it would print the password)" >&2; exit 2;; esac
set +x
umask 077
ulimit -c 0 2>/dev/null || true

die() { echo "ERROR: $*" >&2; exit 2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
confirm() { local a; read -rp "$1 [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]; }

[[ -t 0 && -t 2 ]] || die "run this in an interactive terminal (the password must be typed at a hidden prompt)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$here/gap1-inventory.sql"
[[ -f "$SQL" ]] || die "gap1-inventory.sql must sit next to this script"
need psql; need openssl; need sed; need grep; need perl; need id; need date; need mkdir; need mktemp; need chmod

# ---- credential hygiene: the password lives only in this unexported shell variable ----
DBPW=""
CHILD_PID=""
OUT=""
cleanup() {
  DBPW=""; unset DBPW 2>/dev/null || true
  unset PGPASSWORD 2>/dev/null || true
}
on_exit() {
  local rc=$?
  trap - EXIT
  if [[ -n "$CHILD_PID" ]]; then kill "$CHILD_PID" 2>/dev/null || true; fi
  cleanup
  stty echo 2>/dev/null || true
  if [[ -n "$OUT" && -d "$OUT" ]]; then echo "sensitive variables cleared (exit $rc)" >> "$OUT/cleanup.log"; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

# Clean the environment so nothing saved on this machine can alter or silently supply credentials.
unset PGPASSWORD PGSERVICE PGSERVICEFILE PGOPTIONS PGSSLCERT PGSSLKEY PGSSLCRL PGSSLCRLDIR PGHOSTADDR PGSSLROOTCERT PGSSLMODE \
      PGSSLNEGOTIATION PGSSLCOMPRESSION PGGSSENCMODE PGKRBSRVNAME PGREQUIREAUTH PGCHANNELBINDING
# Collision-safe run directory: mktemp -d creates a NEW, uniquely named directory atomically (mode 0700) or fails; an existing
# directory is never reused. The result is re-checked before use, and OUT is assigned only after every check passes, so a
# rejected directory is never written to (not even by the exit handler).
[[ -d "$HOME" && -w "$HOME" ]] || die "HOME is not a writable directory"
run_dir="$(mktemp -d "$HOME/forgestudio-7b-gap1-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")" || die "could not create a unique output directory"
[[ -n "$run_dir" && -d "$run_dir" && ! -L "$run_dir" ]] || die "output directory is not a real directory; refusing to use it"
shopt -s nullglob dotglob
existing_entries=("$run_dir"/*)
shopt -u nullglob dotglob
[[ "${#existing_entries[@]}" -eq 0 ]] || die "output directory already has content; refusing to reuse or overwrite it"
chmod 700 "$run_dir" || die "could not restrict the output directory to your user"
OUT="$run_dir"
export PGPASSFILE="$OUT/.no-pgpass"
SUMMARY="$OUT/00-summary.txt"
note() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }

# Success flags: exit 0 is only possible when both are 1.
WRONG_CA_OK=0
INV_OK=0
LEAK=0

echo "Output directory (stays on this machine): $OUT"
echo
echo "Non-secret inputs. Copy them from the Supabase dashboard: Connect > Session pooler."
read -rp "Pooler host: " PGHOST
read -rp "Project ref (the text after 'postgres.' in the user name): " PROJECT_REF
read -rp "Path to the Supabase CA certificate you downloaded (Project Settings > Database > SSL Configuration): " CA

[[ "$PGHOST" =~ ^aws-[A-Za-z0-9-]+\.pooler\.supabase\.com$ ]] || die "host must look like aws-<n>-<region>.pooler.supabase.com (session pooler). Direct and transaction-mode endpoints are not covered by this step."
[[ "$PROJECT_REF" =~ ^[a-z0-9]{15,30}$ ]] || die "project ref has an unexpected shape"
[[ -f "$CA" ]] || die "certificate file not found"
grep -q 'BEGIN CERTIFICATE' "$CA" || die "file does not look like a PEM certificate"

# The transport is fixed here. GSS encryption is disabled so that the only encrypted path is TLS with verification.
export PGHOST PGPORT=5432 PGDATABASE=postgres PGUSER="postgres.$PROJECT_REF"
export PGSSLMODE=verify-full PGSSLROOTCERT="$CA" PGSSLMINPROTOCOLVERSION=TLSv1.2 PGGSSENCMODE=disable
export PGCONNECT_TIMEOUT=15 PGAPPNAME=forgestudio-7b-gap1-readonly
assert_tls_env() {
  [[ "${PGSSLMODE:-}" == "verify-full" ]] || die "TLS guard: sslmode must be verify-full"
  [[ "${PGSSLROOTCERT:-}" == "$CA" ]] || die "TLS guard: the CA file must be the one you specified"
  [[ "${PGGSSENCMODE:-}" == "disable" && "${PGSSLMINPROTOCOLVERSION:-}" == "TLSv1.2" ]] || die "TLS guard: transport settings were altered"
}

# ---- Step 1: local-only checks (no network) ----
{
  echo "psql: $(psql --version)"
  echo "openssl: $(openssl version)"
  echo "certificates in file: $(grep -c 'BEGIN CERTIFICATE' "$CA")"
  openssl x509 -in "$CA" -noout -subject -issuer -dates -fingerprint -sha256
} > "$OUT/01-local-checks.txt" 2>&1 || true
cat "$OUT/01-local-checks.txt"
note "step 1 local checks: done"
psql_major="$(psql --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if [[ "$psql_major" =~ ^[0-9]+$ && "$psql_major" -lt 17 ]]; then
  echo "NOTE: this psql is version $psql_major. That is fine for this step, but a later pg_dump of a PostgreSQL 17 server needs pg_dump 17 or newer."
fi

# ---- redaction and quarantine (used by every exit path that produced output) ----
redact() {
  R_HOST="$PGHOST" R_REF="$PROJECT_REF" R_HOME="$HOME" R_CA="$CA" R_OUT="$OUT" perl -pe '
    BEGIN { @lit = ([$ENV{R_CA}, "<ca-file>"], [$ENV{R_OUT}, "<out-dir>"], [$ENV{R_HOST}, "<pooler-host>"],
                    [$ENV{R_REF}, "<project-ref>"], [$ENV{R_HOME}, "<home>"]); }
    for my $p (@lit) { my ($v, $t) = @$p; next if !defined $v || length($v) < 4; s/\Q$v\E/$t/gi; }
    s{postgres(?:ql)?://[^\s"\x27]+}{<conn-url>}gi;
    s{eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}}{<jwt>}g;
    s{sb_(?:secret|publishable)_[A-Za-z0-9_-]+}{<api-key>}g;
    s{[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}}{<email>}g;
    s{\b(?:\d{1,3}\.){3}\d{1,3}\b}{<ip>}g;
  ' "$1" > "$2"
}
# Prints file:line:class (never the matched text). Exit status 1 when anything suspicious remains.
scan_file() {
  perl -ne '
    BEGIN { $hits = 0 }
    (my $l = $_) =~ s/password_encryption|scram-sha-256//g;
    my @c;
    push @c, "credential-word" if $l =~ /passw|secret|token|credential|api[_-]?key|private key|BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/i;
    push @c, "url-or-scheme"   if $l =~ m{://};
    push @c, "jwt-or-key-prefix" if $l =~ /eyJ|sb_(?:secret|publishable)/;
    push @c, "long-token"      if $l =~ /[A-Za-z0-9_\-+\/=]{32,}/;
    push @c, "ipv4"            if $l =~ /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
    push @c, "ipv6"            if $l !~ /ingerprint/ && $l =~ /(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}|[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{1,4})*::[0-9A-Fa-f:]*/;
    push @c, "email"           if $l =~ /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    if (@c) { $hits++; print "$ARGV:$.: ", join(",", @c), "\n"; }
    END { exit($hits ? 1 : 0) }
  ' "$1"
}
# Checks the raw output files for the password value using only bash itself (no helper process, no pipe), then clears the
# variable immediately. Called as soon as psql has exited, before any redaction step runs. Sets LEAK=1 on a hit.
leak_check_and_clear() {
  local f c
  if [[ -n "$DBPW" ]]; then
    for f in "$OUT"/0*.txt "$OUT"/0*.err; do
      [[ -f "$f" ]] || continue
      c=""
      IFS= read -r -d '' c < "$f" || true
      if [[ "$c" == *"$DBPW"* ]]; then echo "${f##*/}: password-value"; LEAK=1; fi
    done
  fi
  c=""
  DBPW=""
}
# Redacts every output file, then scans the redacted copies. Sets SCAN_RC (0, 30 or 31). Never touches the password.
redact_and_scan() {
  local f out bad=0
  SCAN_RC=0
  for f in "$OUT"/0*.txt "$OUT"/0*.err; do
    [[ -f "$f" ]] || continue
    case "$f" in *.redacted.*) continue;; esac
    redact "$f" "${f%.*}.redacted.${f##*.}"
  done
  echo
  echo "== Scan of the redacted files =="
  for out in "$OUT"/*.redacted.*; do
    [[ -f "$out" ]] || continue
    if ! scan_file "$out"; then bad=1; fi
    if grep -F -i -q -e "$PGHOST" -e "$PROJECT_REF" -e "$HOME" "$out" 2>/dev/null; then echo "$out: unredacted-literal"; bad=1; fi
  done
  if [[ "$LEAK" -eq 1 || "$bad" -eq 1 ]]; then
    mkdir -p "$OUT/blocked"
    for out in "$OUT"/*.redacted.*; do [[ -f "$out" ]] && mv "$out" "$OUT/blocked/"; done
    echo
    echo "################ STOP: suspicious content remains after redaction ################"
    echo "The redacted copies were moved to $OUT/blocked/ . DO NOT SHARE ANY OUTPUT."
    if [[ "$LEAK" -eq 1 ]]; then echo "The password value was found in an output file. The unredacted 0* files contain it too: delete them yourself and change the password."; fi
    echo "Open the files listed above yourself, decide what is wrong, and re-run if needed."
    if [[ "$LEAK" -eq 1 ]]; then SCAN_RC=31; else SCAN_RC=30; fi
  else
    echo "no suspicious patterns found (this does NOT replace your own review)"
    printf '%s\n' "These *.redacted.* files were produced automatically and are NOT yet reviewed." \
      "Read every file in full yourself before sharing anything. Do not share the unredacted files." > "$OUT/REVIEW-REQUIRED.txt"
  fi
}
finish() {
  local code="$1"
  # The summary is written before redaction so that it is part of the redacted set.
  if [[ "$INV_OK" -eq 1 && "$WRONG_CA_OK" -eq 1 ]]; then
    note "AUTHORITATIVE TLS RESULT: ESTABLISHED. The psql inventory connection succeeded with sslmode=verify-full, hostname verification, the CA file you supplied, TLS 1.2 or newer and GSS encryption disabled."
  else
    note "AUTHORITATIVE TLS RESULT: NOT ESTABLISHED. The psql verify-full inventory connection did not complete successfully. Nothing here counts as verified TLS."
  fi
  redact_and_scan
  if [[ "$LEAK" -eq 1 ]]; then code=31
  elif [[ "$code" -eq 0 && "$SCAN_RC" -ne 0 ]]; then code="$SCAN_RC"
  elif [[ "$code" -eq 0 && ( "$WRONG_CA_OK" -ne 1 || "$INV_OK" -ne 1 ) ]]; then code=52
  fi
  # The final code is appended to the summary (raw and any redacted copy) so a connection that verified can never be mistaken for a run that passed.
  for s in "$SUMMARY" "$OUT/00-summary.redacted.txt" "$OUT/blocked/00-summary.redacted.txt"; do
    if [[ -f "$s" ]]; then printf 'FINAL EXIT CODE: %s (0 means every requirement passed; anything else is not a successful run)\n' "$code" >> "$s"; fi
  done
  echo
  echo "Result: exit code $code. Summary: $SUMMARY"
  if [[ "$code" -eq 0 ]]; then
    echo "Share ONLY the *.redacted.* files, and only after reading each one in full. Never share the unredacted files or your shell history."
    echo "When finished you may delete the raw 0*.txt and 0*.err files in $OUT yourself."
  else
    echo "NOT SUCCESSFUL (exit code $code). Do not treat this run as verification of anything."
  fi
  exit "$code"
}

echo
confirm "Steps 2 and 3 contact $PGHOST:5432 (TLS verify-full against your CA file). Continue?" \
  || { note "NOT RUN: you declined the network confirmation. Nothing was contacted."; finish 50; }

# ---- Step 2: OpenSSL handshake probe (INFORMATIONAL ONLY; no login, no SQL) ----
assert_tls_env
t=""; command -v timeout >/dev/null 2>&1 && t="timeout 30"
if $t openssl s_client -starttls postgres -connect "$PGHOST:5432" -servername "$PGHOST" \
     -CAfile "$CA" -verify_hostname "$PGHOST" -verify_return_error -brief </dev/null > "$OUT/02-handshake.txt" 2>&1; then
  note "step 2 OpenSSL probe (INFORMATIONAL ONLY, not the TLS result of record): the handshake completed"
else
  note "step 2 OpenSSL probe (INFORMATIONAL ONLY, not the TLS result of record): it reported an error; the pooler may not support this probe"
fi
cat "$OUT/02-handshake.txt"

# ---- Step 2b (mandatory): a wrong trust anchor must be rejected; any success or unclear result stops everything ----
assert_tls_env
decoy="$OUT/decoy-ca.crt"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/.decoy.key" -out "$decoy" -subj "/CN=decoy-not-supabase" -days 1 >/dev/null 2>&1 \
  || { note "step 2b wrong-CA test: could not create the decoy CA - STOP"; finish 21; }
rm -f "$OUT/.decoy.key"
rc=0
PGSSLMODE=verify-full PGSSLROOTCERT="$decoy" psql -X -w -c 'select 1' > "$OUT/02b-wrong-ca.txt" 2>&1 </dev/null || rc=$?
echo "exit code: $rc" >> "$OUT/02b-wrong-ca.txt"
if [[ "$rc" -eq 0 ]]; then
  note "step 2b wrong-CA test: FAIL - the connection SUCCEEDED with a wrong CA, so certificate verification is NOT enforced. STOP."
  finish 20
elif grep -Eiq 'certificate verify failed|self[- ]signed|unable to get (local )?issuer|unknown ca|certificate.*not trusted' "$OUT/02b-wrong-ca.txt"; then
  note "step 2b wrong-CA test: PASS (rejected with a certificate verification error)"
  WRONG_CA_OK=1
else
  note "step 2b wrong-CA test: INCONCLUSIVE - it failed, but not with a certificate verification error. STOP."
  finish 21
fi

# ---- Step 3: read-only inventory over verify-full (the AUTHORITATIVE TLS check) ----
FINAL=0
if confirm "Step 3: connect as $PGUSER with verify-full and run the READ-ONLY inventory (catalogs only)?"; then
  [[ -t 0 ]] || die "password must be typed in a terminal"
  read -rsp "Database password (typed here only; never shared): " DBPW; echo
  [[ -n "$DBPW" ]] || die "empty password"
  assert_tls_env
  rc=0
  PGPASSWORD="$DBPW" psql -X -w -v ON_ERROR_STOP=1 -f "$SQL" > "$OUT/03-inventory.txt" 2> "$OUT/03-inventory.err" </dev/null &
  CHILD_PID=$!
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  leak_check_and_clear
  echo "psql exit code: $rc" > "$OUT/03-exit-code.txt"
  if [[ "$rc" -ne 0 ]]; then
    if grep -q 'GAP1_GATE_FAILED' "$OUT/03-inventory.err" 2>/dev/null; then
      note "step 3 inventory: FAIL - the read-only safety gate failed (psql exit $rc)"
    else
      note "step 3 inventory: FAIL (psql exit $rc). Read $OUT/03-inventory.err yourself; share it only after redaction."
    fi
    FINAL=40
  elif ! grep -qx 'GAP1_GATE_OK' "$OUT/03-inventory.txt" || ! grep -qx 'GAP1_INVENTORY_COMPLETE' "$OUT/03-inventory.txt"; then
    note "step 3 inventory: FAIL - psql exited 0 but the success markers are missing (treated as failure)"
    FINAL=41
  else
    note "step 3 inventory: PASS (read-only gate confirmed, all sections completed)"
    INV_OK=1
    if grep -Eiq 'SSL connection|SSL Connection|protocol: *TLS|TLSv1' "$OUT/03-inventory.txt"; then
      note "psql printed TLS details in the inventory output (informational)"
    else
      note "psql did not print recognizable TLS details (informational; psql versions format this differently)"
    fi
  fi
else
  note "step 3 inventory: NOT RUN (you declined). No inventory exists and no TLS result of record was obtained."
  FINAL=51
fi

finish "$FINAL"
