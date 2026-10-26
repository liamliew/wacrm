import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, fakeCtx, allScopedTo } from '@/test/fake-supabase';
import { forbidden } from '@/lib/api/v1/respond';

const h = vi.hoisted(() => ({ db: null as unknown, scopes: [] as string[], accountId: 'acct-1' }));

vi.mock('@/lib/auth/api-context', async () => {
  const { fakeCtx } = await import('@/test/fake-supabase');
  const { forbidden } = await import('@/lib/api/v1/respond');
  return {
    requireApiKey: async (_req: Request, scope?: string) => {
      if (scope && !h.scopes.includes(scope)) throw forbidden(`missing '${scope}'`);
      return fakeCtx(h.db as FakeDb, { accountId: h.accountId, scopes: h.scopes });
    },
  };
});

import { collection, item } from './crud';
import { TAGS, DEALS } from './resources';

const tags = collection(TAGS);
const tag = item(TAGS);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let db: FakeDb;
const req = (method: string, body?: unknown, url = 'https://x.test/api/v1/tags') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => res.json();

beforeEach(() => {
  db = new FakeDb();
  db.seed('accounts', [{ id: 'acct-1', owner_user_id: 'owner-1' }, { id: 'acct-2', owner_user_id: 'owner-2' }]);
  db.seed('tags', [
    { id: A, account_id: 'acct-1', user_id: 'owner-1', name: 'VIP', color: '#111111', created_at: '2026-01-02T00:00:00Z' },
    { id: B, account_id: 'acct-2', user_id: 'owner-2', name: 'Other', color: '#222222', created_at: '2026-01-01T00:00:00Z' },
  ]);
  h.db = db;
  h.scopes = ['settings:read', 'settings:write'];
  h.accountId = 'acct-1';
});

describe('collection GET', () => {
  it('lists only the key\'s account and never leaks internal columns', async () => {
    const res = await tags.GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({ id: A, name: 'VIP', color: '#111111', created_at: '2026-01-02T00:00:00Z' });
    expect(body.meta.next_cursor).toBeNull();
    expect(allScopedTo(db, ['tags'], 'acct-1')).toBe(true);
  });

  it('needs the read scope', async () => {
    h.scopes = ['settings:write'];
    const res = await tags.GET(req('GET'));
    expect(res.status).toBe(403);
  });

  it('rejects a malformed filter value', async () => {
    const deals = collection(DEALS);
    h.scopes = ['pipelines:read'];
    const res = await deals.GET(req('GET', undefined, 'https://x.test/api/v1/deals?pipeline_id=nope'));
    expect(res.status).toBe(400);
    const bad = await deals.GET(req('GET', undefined, 'https://x.test/api/v1/deals?status=weird'));
    expect(bad.status).toBe(400);
  });
});

describe('collection POST', () => {
  it('creates in the key\'s account, attributes the owner, and audits field names only', async () => {
    const res = await tags.POST(req('POST', { name: 'Lead', color: '#3b82f6' }));
    expect(res.status).toBe(201);
    const created = (await json(res)).data;
    expect(created).toMatchObject({ name: 'Lead', color: '#3b82f6' });
    const row = db.rows('tags').find((r) => r.name === 'Lead')!;
    expect(row).toMatchObject({ account_id: 'acct-1', user_id: 'owner-1' });
    const audit = db.rows('api_audit_log');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      account_id: 'acct-1',
      api_key_id: 'key-1',
      action: 'tag.create',
      resource_type: 'tag',
      summary: { fields: ['name', 'color'] },
    });
    expect(JSON.stringify(audit[0])).not.toContain('#3b82f6');
  });

  it('cannot create in another account by passing account_id', async () => {
    const res = await tags.POST(req('POST', { name: 'X', account_id: 'acct-2' }));
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("Unknown field 'account_id'");
    expect(db.rows('tags')).toHaveLength(2);
  });

  it('validates input', async () => {
    expect((await tags.POST(req('POST', {}))).status).toBe(400);
    expect((await tags.POST(req('POST', { name: '   ' }))).status).toBe(400);
    expect((await tags.POST(req('POST', { name: 'x'.repeat(61) }))).status).toBe(400);
    expect((await tags.POST(req('POST', { name: 'ok', color: 'red' }))).status).toBe(400);
    expect((await tags.POST(req('POST', { name: 5 }))).status).toBe(400);
    expect((await tags.POST(req('POST', [1]))).status).toBe(400);
    expect(db.rows('api_audit_log')).toHaveLength(0);
  });

  it('refuses a duplicate name in the account (case-insensitive) but allows it in another', async () => {
    const dup = await tags.POST(req('POST', { name: 'vip' }));
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.code).toBe('conflict');
    h.accountId = 'acct-2';
    const other = await tags.POST(req('POST', { name: 'VIP' }));
    expect(other.status).toBe(201);
  });

  it('needs the write scope', async () => {
    h.scopes = ['settings:read'];
    expect((await tags.POST(req('POST', { name: 'Z' }))).status).toBe(403);
    expect(db.rows('tags')).toHaveLength(2);
  });
});

describe('item routes', () => {
  it('reads, but only within the account', async () => {
    expect((await tag.GET(req('GET'), ctxFor(A))).status).toBe(200);
    const foreign = await tag.GET(req('GET'), ctxFor(B));
    expect(foreign.status).toBe(404);
    expect((await tag.GET(req('GET'), ctxFor('not-a-uuid'))).status).toBe(400);
  });

  it('patches an own row, audits it, and leaves other accounts alone', async () => {
    const res = await tag.PATCH(req('PATCH', { color: '#abcdef' }), ctxFor(A));
    expect(res.status).toBe(200);
    expect(db.rows('tags').find((r) => r.id === A)!.color).toBe('#abcdef');
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'tag.update', resource_id: A });

    const foreign = await tag.PATCH(req('PATCH', { color: '#000000' }), ctxFor(B));
    expect(foreign.status).toBe(404);
    expect(db.rows('tags').find((r) => r.id === B)!.color).toBe('#222222');
  });

  it('rejects an empty patch and renaming onto an existing name', async () => {
    expect((await tag.PATCH(req('PATCH', {}), ctxFor(A))).status).toBe(400);
    db.seed('tags', [{ id: '33333333-3333-4333-8333-333333333333', account_id: 'acct-1', user_id: 'owner-1', name: 'Hot', color: '#000000', created_at: '2026-01-03T00:00:00Z' }]);
    const clash = await tag.PATCH(req('PATCH', { name: 'hot' }), ctxFor(A));
    expect(clash.status).toBe(409);
    // renaming a row to its own name (case change) is fine
    expect((await tag.PATCH(req('PATCH', { name: 'vip' }), ctxFor(A))).status).toBe(200);
  });

  it('deletes an own row only', async () => {
    const foreign = await tag.DELETE!(req('DELETE'), ctxFor(B));
    expect(foreign.status).toBe(404);
    expect(db.rows('tags')).toHaveLength(2);
    const res = await tag.DELETE!(req('DELETE'), ctxFor(A));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ id: A, deleted: true });
    expect(db.rows('tags').map((r) => r.id)).toEqual([B]);
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'tag.delete' });
  });

  it('every query touching tags was scoped to the account', async () => {
    await tag.PATCH(req('PATCH', { color: '#abcdef' }), ctxFor(A));
    await tag.DELETE!(req('DELETE'), ctxFor(A));
    await tags.GET(req('GET'));
    expect(allScopedTo(db, ['tags'], 'acct-1')).toBe(true);
  });

  it('turns a database uniqueness error into 409 and other errors into a generic 500', async () => {
    db.failures.set('tags:insert', { message: 'dup', code: '23505' });
    expect((await tags.POST(req('POST', { name: 'New' }))).status).toBe(409);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.failures.set('tags:insert', { message: 'secret internals', code: 'XX000' });
    const res = await tags.POST(req('POST', { name: 'New2' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain('secret internals');
    err.mockRestore();
  });
});

describe('audit failure does not break the write', () => {
  it('still returns success when the audit insert fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.failures.set('api_audit_log:insert', { message: 'audit table missing' });
    const res = await tags.POST(req('POST', { name: 'Fine' }));
    expect(res.status).toBe(201);
    err.mockRestore();
  });
});

void fakeCtx; void forbidden;
