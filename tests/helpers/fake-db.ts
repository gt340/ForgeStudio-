// Tiny in-memory stand-in for the Supabase client, just rich enough for ForgeStudio's API routes.
// It applies .eq()/.neq() filters (so ownership scoping done by the route is really exercised),
// projects selected columns (so a route that forgets to exclude a secret column is caught), and can
// be told to fail UPDATEs the way the real database did before the Phase 6A grant fix (42501).

export type Row = Record<string, any>;
export type DbOp = {
  seq: number;
  table: string;
  op: 'select' | 'update' | 'insert' | 'delete';
  cols: string;
  filters: [string, 'eq' | 'neq', unknown][];
  payload?: Row;
  failed?: boolean;
};

let counter = 0;
/** Shared monotonically increasing counter so DB operations and fake HTTP calls can be ordered. */
export const tick = () => ++counter;

export function createFakeDb(
  seed: Record<string, Row[]> = {},
  opts: { failUpdate?: (table: string, payload: Row) => boolean } = {}
) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ops: DbOp[] = [];

  const pick = (row: Row, cols: string): Row => {
    if (!cols || cols.trim() === '*') return { ...row };
    const out: Row = {};
    for (const c of cols.split(',').map((s) => s.trim())) {
      if (c in row) out[c] = row[c];
    }
    return out;
  };

  function from(table: string) {
    const st = {
      op: 'select' as DbOp['op'],
      cols: '*',
      filters: [] as DbOp['filters'],
      payload: undefined as Row | undefined,
    };

    const run = (single: boolean) => {
      const rows = (tables[table] ??= []);
      const matches = rows.filter((r) =>
        st.filters.every(([c, kind, v]) => (kind === 'eq' ? r[c] === v : r[c] !== v))
      );
      const op: DbOp = { seq: tick(), table, op: st.op, cols: st.cols, filters: [...st.filters], payload: st.payload };
      ops.push(op);

      if (st.op === 'select') {
        if (single) {
          return matches[0]
            ? { data: pick(matches[0], st.cols), error: null }
            : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        }
        return { data: matches.map((r) => pick(r, st.cols)), error: null };
      }
      if (st.op === 'update') {
        if (opts.failUpdate?.(table, st.payload ?? {})) {
          op.failed = true;
          return { data: null, error: { code: '42501', message: `permission denied for table ${table}` } };
        }
        matches.forEach((r) => Object.assign(r, st.payload));
        return { data: null, error: null };
      }
      if (st.op === 'insert') {
        rows.push({ ...st.payload });
        return { data: null, error: null };
      }
      tables[table] = rows.filter((r) => !matches.includes(r));
      return { data: null, error: null };
    };

    const q: any = {
      select: (cols = '*') => {
        if (st.op === 'select') st.cols = cols;
        return q;
      },
      update: (p: Row) => {
        st.op = 'update';
        st.payload = p;
        return q;
      },
      insert: (p: Row) => {
        st.op = 'insert';
        st.payload = p;
        return q;
      },
      delete: () => {
        st.op = 'delete';
        return q;
      },
      eq: (c: string, v: unknown) => {
        st.filters.push([c, 'eq', v]);
        return q;
      },
      neq: (c: string, v: unknown) => {
        st.filters.push([c, 'neq', v]);
        return q;
      },
      order: () => q,
      limit: () => q,
      single: () => Promise.resolve(run(true)),
      then: (resolve: any, reject: any) => Promise.resolve(run(false)).then(resolve, reject),
    };
    return q;
  }

  return { from, ops, tables };
}

export type FakeDb = ReturnType<typeof createFakeDb>;
