// ============================================================
// A small in-memory stand-in for the parts of supabase-js the /api/v1
// routes use, so route tests can run real queries (filters, inserts,
// updates, deletes) and assert on tenancy instead of mocking each call.
//
// Supported: from(t).select().eq/neq/in/is/gt/gte/lt/lte/or(ignored)
// .order().limit().range().maybeSingle()/single(); insert(row|rows)
// (+ .select()); update(patch); delete(); awaiting the builder.
// Not supported: joins/embeds (the select string is ignored and whole
// rows come back), RPC.
// ============================================================

type Row = Record<string, unknown>;
type Filter = { col: string; op: string; val: unknown };
export interface LoggedQuery {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Filter[];
  payload?: unknown;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  log: LoggedQuery[] = [];
  /** Errors to return for the next matching call: key `${table}:${op}`. */
  failures = new Map<string, { message: string; code?: string }>();
  /** Columns that must be unique per table, to emulate 23505. */
  unique: Record<string, string[]> = {};
  /** rpc(name, args) handlers; each returns { data, error }. */
  rpcHandlers: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }> = {};
  rpcLog: { name: string; args: Record<string, unknown> }[] = [];
  private seq = 0;

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
    return this;
  }
  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }
  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }
  rpc(name: string, args: Record<string, unknown>) {
    this.rpcLog.push({ name, args });
    const h = this.rpcHandlers[name];
    return Promise.resolve(h ? h(args) : { data: null, error: { message: `no rpc ${name}` } });
  }
  from(table: string): Query {
    return new Query(this, table);
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: LoggedQuery['op'] | 'upsert' = 'select';
  private conflictCols: string[] = [];
  private filters: Filter[] = [];
  private payload: unknown;
  private orderBy: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private singleMode: 'one' | 'maybe' | null = null;
  private returning = false;
  private cols: string[] | null = null;

  constructor(private db: FakeDb, private table: string) {}

  select(cols?: string): this {
    this.returning = true;
    // Project simple column lists so tests can assert nothing internal
    // (account_id, user_id, secrets) leaks. Embeds like `a(b)` are skipped.
    if (cols && cols.trim() !== '*') {
      const names = cols.split(',').map((c) => c.trim()).filter((c) => c && !/[()!:]/.test(c));
      this.cols = names.length && !names.includes('*') ? names : null;
    }
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = payload;
    this.conflictCols = (opts?.onConflict ?? 'id').split(',').map((c) => c.trim());
    return this;
  }
  update(patch: Row): this {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  delete(): this {
    this.op = 'delete';
    return this;
  }
  eq(col: string, val: unknown): this { return this.f(col, 'eq', val); }
  neq(col: string, val: unknown): this { return this.f(col, 'neq', val); }
  in(col: string, val: unknown[]): this { return this.f(col, 'in', val); }
  is(col: string, val: unknown): this { return this.f(col, 'is', val); }
  gt(col: string, val: unknown): this { return this.f(col, 'gt', val); }
  gte(col: string, val: unknown): this { return this.f(col, 'gte', val); }
  lt(col: string, val: unknown): this { return this.f(col, 'lt', val); }
  lte(col: string, val: unknown): this { return this.f(col, 'lte', val); }
  or(): this { return this; }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number): this { this.lim = n; return this; }
  range(from: number, to: number): this { this.rng = [from, to]; return this; }
  maybeSingle(): this { this.singleMode = 'maybe'; return this; }
  // supabase-js `.single()` errors when there is not exactly one row.
  singleRow(): this { this.singleMode = 'one'; return this; }

  private f(col: string, op: string, val: unknown): this {
    this.filters.push({ col, op, val });
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(({ col, op, val }) => {
      const v = row[col];
      switch (op) {
        case 'eq': return v === val;
        case 'neq': return v !== val;
        case 'in': return (val as unknown[]).includes(v);
        case 'is': return val === null ? v === null || v === undefined : v === val;
        case 'gt': return (v as string | number) > (val as string | number);
        case 'gte': return (v as string | number) >= (val as string | number);
        case 'lt': return (v as string | number) < (val as string | number);
        case 'lte': return (v as string | number) <= (val as string | number);
        default: return true;
      }
    });
  }

  private run(): { data: unknown; error: unknown } {
    const db = this.db;
    db.log.push({ table: this.table, op: (this.op === 'upsert' ? 'insert' : this.op), filters: [...this.filters], payload: this.payload });
    const failure = db.failures.get(`${this.table}:${this.op}`);
    if (failure) {
      db.failures.delete(`${this.table}:${this.op}`);
      return { data: null, error: failure };
    }
    const rows = (db.tables[this.table] ??= []);
    let result: Row[] = [];

    if (this.op === 'upsert') {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const r of incoming) {
        const hit = rows.find((x) => this.conflictCols.every((c) => x[c] === r[c]));
        if (hit) {
          Object.assign(hit, r);
          result.push(hit);
        } else {
          const row: Row = { id: db.nextId(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          result.push(row);
        }
      }
    } else if (this.op === 'insert') {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const r of incoming) {
        for (const col of db.unique[this.table] ?? []) {
          if (rows.some((x) => x[col] === r[col] && x['account_id'] === r['account_id'])) {
            return { data: null, error: { message: `duplicate key on ${col}`, code: '23505' } };
          }
        }
        const row: Row = { id: db.nextId(), created_at: new Date().toISOString(), ...r };
        rows.push(row);
        result.push(row);
      }
    } else if (this.op === 'update') {
      for (const row of rows) {
        if (this.matches(row)) {
          Object.assign(row, this.payload as Row);
          if ('updated_at' in row) row['updated_at'] = new Date().toISOString();
          result.push(row);
        }
      }
    } else if (this.op === 'delete') {
      const keep: Row[] = [];
      for (const row of rows) (this.matches(row) ? result : keep).push(row);
      db.tables[this.table] = keep;
    } else {
      result = rows.filter((r) => this.matches(r));
    }

    for (const { col, asc } of [...this.orderBy].reverse()) {
      result = [...result].sort((a, b) => {
        const x = a[col] as string | number;
        const y = b[col] as string | number;
        return x === y ? 0 : (x < y ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.rng) result = result.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim !== null) result = result.slice(0, this.lim);

    const out = result.map((r) => {
      if (!this.cols) return { ...r };
      const picked: Row = {};
      for (const c of this.cols) if (c in r) picked[c] = r[c];
      return picked;
    });
    if (this.singleMode === 'maybe') {
      return out.length > 1
        ? { data: null, error: { message: 'multiple rows' } }
        : { data: out[0] ?? null, error: null };
    }
    if (this.singleMode === 'one') {
      return out.length === 1
        ? { data: out[0], error: null }
        : { data: null, error: { message: `expected 1 row, got ${out.length}` } };
    }
    const wantsRows = this.op === 'select' || this.returning;
    return { data: wantsRows ? out : null, error: null };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

// supabase-js calls it `.single()`; expose it under that name too.
(Query.prototype as unknown as { single: () => Query }).single = function (this: Query) {
  return this.singleRow();
};

/** A fake ApiKeyContext around a FakeDb. */
export function fakeCtx(db: FakeDb, over: Partial<{ accountId: string; keyId: string; scopes: string[] }> = {}) {
  return {
    authType: 'api_key' as const,
    supabase: db as unknown as import('@supabase/supabase-js').SupabaseClient,
    accountId: over.accountId ?? 'acct-1',
    keyId: over.keyId ?? 'key-1',
    scopes: over.scopes ?? [],
    createdBy: 'user-1' as string | null,
  };
}

/** Every logged query on `tables` filtered by account_id = `accountId`. */
export function allScopedTo(db: FakeDb, tables: string[], accountId: string): boolean {
  return db.log
    .filter((q) => tables.includes(q.table) && q.op !== 'insert')
    .every((q) => q.filters.some((f) => f.col === 'account_id' && f.val === accountId));
}
