# supabase/pending

SQL that is **reviewed and tested but NOT applied to production**. Files here are never picked up by migration
tooling or the Supabase GitHub integration (they only read `supabase/migrations/`).

Applying a file from here is a production change: it needs the Commander's explicit authorization and the preflight,
verification and rollback steps in `docs/PHASE-7B-PRODUCTION-CHANGE-PLAN.md`. After it is applied, move it to
`supabase/migrations/` using the version recorded in production history.

Current contents:
- `20261010120000_least_privilege_public_tables.sql` - Phase 7B least-privilege table grants (rollback: `supabase/rollbacks/`).
