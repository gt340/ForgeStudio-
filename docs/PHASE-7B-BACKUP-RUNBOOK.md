# Phase 7B backup runbook (DRAFT, for review)

**Status: DRAFT. Every command below is labeled UNTESTED until successful CI evidence is attached to it (see section 3).**
**Passing the disposable-database test does NOT authorize running anything against production.** Production backups, Change 1 and
Change 2 each still need a separate, explicit Commander authorization.

## 1. Scope and purpose

A **recovery aid for the two Phase 7B changes** (`supabase/pending/phase-7b-release/`): a copy of the application schema `public`
(five tables, their data, constraints, indexes, policies, table ACLs, default privileges, the function `rls_auto_enable()`) taken before
Change 1 so the pre-change state can be inspected or rebuilt if something goes wrong. It is **not** a disaster-recovery backup (section 13).

The procedure is exercised by `tests/integration/pg17-backup-validation.test.ts` against two disposable `postgres:17.6` containers with
synthetic data only. The test connects to nothing else; it never touches Supabase.

## 2. Tested versions

| Component | Version tested in CI | Source |
|---|---|---|
| PostgreSQL server (source and restore target) | 17.6 (image `postgres:17.6`, no fallback image) | asserted by the test (`show server_version`) |
| `pg_dump`, `pg_restore`, `psql` | 17.6, the binaries inside those images | asserted by the test (`--version`) |
| `gpg` | the version on the GitHub-hosted `ubuntu-latest` runner | printed in the CI evidence |

Production is PostgreSQL 17.6 (measured earlier read-only). A PostgreSQL 16 client must **not** be used: `pg_dump` refuses a newer
server, and a local PG16 run is never evidence for this procedure.

## 3. Commands and their status

Placeholders: `<project-ref>`, `<pooler-host>`, `$BK` (backup directory outside the repository). Never replace a placeholder with a password.

Status legend: **UNTESTED** = not yet supported by successful CI evidence. **TESTED-IN-DISPOSABLE-CI** = the same flags ran successfully
in the CI run named in the status column; it still says nothing about production transport or permissions.

| # | Step | Command | Status |
|---|---|---|---|
| 1 | Prepare a private directory outside the repository | `umask 077; BK="$HOME/forge-backups/$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$BK"` | UNTESTED (the test uses `mkdtemp` outside the repo, mode 700) |
| 2 | Enter the password at a hidden prompt, without history | `set +o history; read -rsp 'DB password: ' PGPASSWORD; echo; export PGPASSWORD` | UNTESTED (the test passes the password through the process environment) |
| 3 | Dump schema `public` (custom format) | `pg_dump -h <pooler-host> -p 5432 -U postgres.<project-ref> -d postgres -w --schema=public --format=custom > "$BK/forgestudio-public.dump.partial"` | UNTESTED (flags `-w --schema=public --format=custom`) |
| 4 | Keep only a successful, non-empty dump | `test -s "$BK/forgestudio-public.dump.partial" && mv "$BK/forgestudio-public.dump.partial" "$BK/forgestudio-public.dump"` | UNTESTED |
| 5 | Clear the password | `unset PGPASSWORD; set -o history` | UNTESTED |
| 6 | Readability check, nothing printed except a count | `pg_restore --list "$BK/forgestudio-public.dump" \| grep -c ' TABLE DATA public '` (expect 5) | UNTESTED |
| 7 | SHA-256 of the dump and a catalog snapshot | `( cd "$BK" && sha256sum forgestudio-public.dump source.snapshot > SHA256SUMS && sha256sum -c SHA256SUMS )` | UNTESTED |
| 8 | Bundle and encrypt (GPG symmetric AES-256), passphrase from a hidden prompt | `tar -cf "$BK/bundle.tar" -C "$BK" forgestudio-public.dump source.snapshot SHA256SUMS && read -rsp 'Passphrase: ' P; echo; printf '%s\n' "$P" \| gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 --output "$BK/forgestudio-backup.tar.gpg" "$BK/bundle.tar"; unset P` | UNTESTED (flags `--batch --yes --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256`) |
| 9 | Checksum of the encrypted file, then delete the plaintext | `( cd "$BK" && sha256sum forgestudio-backup.tar.gpg > SHA256SUMS.gpg && sha256sum -c SHA256SUMS.gpg ) && rm -f "$BK/bundle.tar" "$BK/forgestudio-public.dump" "$BK/source.snapshot" "$BK/SHA256SUMS"` | UNTESTED |
| 10 | Second protected location | copy `forgestudio-backup.tar.gpg` and `SHA256SUMS.gpg` to a second, independently protected place; run `sha256sum -c SHA256SUMS.gpg` there | UNTESTED (the test verifies two local directories only) |
| 11 | Restore into a separate disposable instance | prepare the target (roles `postgres anon authenticated service_role authenticator`, an `auth` schema with `auth.users(id)` and `auth.uid()`; see `supabase/tests/pg17-backup-target-prep.sql`), then `pg_restore -h <disposable-host> -U <superuser> -d <empty-db> -w --single-transaction forgestudio-public.dump` | UNTESTED |
| 12 | Re-create what the dump does not carry | `create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();` as a superuser, plus the default privileges of section 9 if they were not restored | UNTESTED |
| 13 | Compare source and restore | run `supabase/tests/pg17-backup-verify.sql` on both (`psql -X -At -v ON_ERROR_STOP=1 -f`) and diff the two outputs | UNTESTED |

Status changes from UNTESTED are made only after a CI run on this branch has passed, and only for the exact flags that run used.
The production-facing form of steps 2, 3 and 11 (session pooler, `sslmode`, the `postgres.<project-ref>` role) is **never** covered by the
disposable test and stays UNTESTED until a Commander-authorized production run proves it.

## 4. Credentials and shell history

- Never put a password on a command line, in a file in the repository, in chat, in a ticket or in a log.
- Use a hidden prompt (`read -rsp`) and `set +o history` around it (or a shell started with `HISTFILE=/dev/null`). Unset the variable immediately after use.
- `PGPASSWORD` lives in the process environment and is readable by the same OS user and, for containers, by `docker inspect`. Accepted only for short-lived commands on a machine you control; the CI test uses it only for random, per-run passwords of throw-away containers.
- Never print a dump, a decrypted bundle or an environment dump to the terminal, and never paste connection strings with passwords into any output.

## 5. Artifact location

Write artifacts only to a private directory **outside** the repository (mode `700`, files `600`). The repository `.gitignore` is not a safe place for a dump; do not keep one in the working tree, in CI artifacts, in chat or in a cloud-synced folder that is not itself encrypted.

## 6. Encryption

GPG symmetric, cipher AES-256 (`--symmetric --cipher-algo AES256`). The test checks the packet header names `AES256`, decrypts the bundle again, compares the SHA-256 of the dump after the round trip, and proves a wrong passphrase fails. Store the passphrase separately from the artifact (password manager). A lost passphrase means a lost backup.

## 7. Checksums

`SHA256SUMS` inside the bundle (dump and snapshot) and a separate SHA-256 of the encrypted file. Verify with `sha256sum -c`. A checksum proves the file is unchanged since it was written; it does not prove the backup is complete (use section 10).

## 8. Two protected locations

Keep two copies in independently protected places (for example two different encrypted drives or accounts). After copying, verify each copy with `sha256sum -c`. The test models this with two local directories only; real independence is a Commander decision.

## 9. Restore into a separate disposable instance, and objective pass/fail

Restore only into a disposable instance, never into the production project. `pg_dump --schema=public` writes `CREATE SCHEMA public`, so the target's own empty `public` must be dropped first (done by the target-prep script, with the disposable-only warning).

**PASS requires all of:** `pg_restore` exit 0; zero differences between the source and restored snapshots in the categories tables, columns, constraints (PK/FK/CHECK/UNIQUE), indexes, policies, table ACLs, functions (owner, security definer, ACL, source md5), row counts and content hashes; the empty table restored empty; the event trigger and the default privileges identical after the recovery DDL of step 12.
**Anything else is FAIL.** Observed-only items (schema ACL, default ACLs, event trigger) are reported in the CI evidence with whether the dump preserved them.

What the dump format does and does not preserve is recorded from CI evidence in section 11 (to be completed from the CI run; until then treat every statement there as UNTESTED).

## 10. Failure response and stop conditions

Stop and do not proceed to Change 1 if any of the following happens: a command exits non-zero; the dump is empty or `pg_restore --list` fails; a checksum does not verify; the decrypted bundle differs; the restore fails or the snapshot comparison shows any difference; a password or secret appeared in any output (treat it as compromised, rotate it, tell the Commander). Delete a failed `.partial` file; never describe a failed or unverified artifact as a backup. The failure modes below are exercised by the CI test and must keep failing correctly: missing database, wrong password, missing/empty/truncated/corrupted artifact, wrong checksum, wrong GPG passphrase, failed restore, tampered restore, missing client binary, unavailable image, PostgreSQL 16 client.

## 11. What the backup includes and excludes (from the CI evidence)

Verified by the CI test once it has passed (status: **UNTESTED until the CI run is attached**): tables, columns, constraints, indexes, policies, table ACLs, the function `rls_auto_enable()`, row data.
Recorded as observed differences in the CI evidence: whether default privileges, the schema ACL and the event trigger are carried by a `--schema=public` dump. The local PostgreSQL 16 smoke run (not evidence for 17.6) suggested that the event trigger is not carried, so step 12 re-creates it, and that the default ACLs are.
Not included by design: any schema other than `public`.

## 12. Disposable replica versus production (documented differences)

- The replica creates `auth.users(id, email)` and `auth.uid()` as stand-ins; production has the real `auth` schema, which a `public` dump does not contain.
- Roles are bootstrapped by the test; real role passwords, memberships and attributes are cluster-level and are not in the dump.
- The replica's bootstrap superuser is `supabase_admin`; the dump is taken as the non-superuser `postgres` there, and restored as a superuser. On production, `supabase_admin` is not usable by us; the event trigger is owned by it, so it can only be re-created by the platform.
- Transport: the test dumps over TCP inside the container network with password authentication; production uses the session pooler over TLS.

## 13. Supabase-specific limitations (not a disaster-recovery solution)

- A dump of `public` does not include `auth` (users, identities, sessions), `storage` (buckets and objects, and the objects themselves), `extensions`, other platform schemas, cluster roles and their passwords, Edge Functions, secrets, or project configuration (auth providers, redirect URLs, API keys, network settings).
- Rows in `integrations` (access/refresh tokens) and `env_vars` (values) may contain real secrets: a real dump is sensitive material and must be handled and stored as such. Rotate affected tokens if an artifact is ever exposed.
- Managed backups and point-in-time recovery depend on the Supabase plan; this project is on the Free plan, which has no PITR. Verify the current state in the dashboard rather than assuming it.
- The disposable test does not prove the production session-pooler transport, the `postgres.<project-ref>` role's permission to read every object, or Supabase's own restore tooling.
- Full disaster recovery is **not** claimed. It needs verified recovery procedures for auth users, storage objects, roles, project configuration and external services, none of which this runbook covers.

## 14. Authorization

This runbook and its test **do not authorize production execution**. Running a backup against production, applying Change 1 or Change 2, or moving the migration out of `supabase/pending/` each require a separate, explicit Commander authorization. Until the backup is taken, verified (sections 6-9) and confirmed by the Commander, production changes stay blocked.
