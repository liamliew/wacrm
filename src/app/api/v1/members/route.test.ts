import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '@/test/fake-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, scopes: [] as string[] }));
vi.mock('@/lib/auth/api-context', async () => {
  const { fakeCtx } = await import('@/test/fake-supabase');
  const { forbidden } = await import('@/lib/api/v1/respond');
  return {
    requireApiKey: async (_r: Request, scope?: string) => {
      if (scope && !h.scopes.includes(scope)) throw forbidden(`missing '${scope}'`);
      return fakeCtx(h.db as FakeDb, { scopes: h.scopes });
    },
  };
});
import { GET } from './route';

describe('GET /api/v1/members', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb().seed('profiles', [
      { user_id: 'u1', account_id: 'acct-1', full_name: 'Aiman', email: 'a@x.com', account_role: 'owner', created_at: '2026-01-01', avatar_url: 'secret-avatar' },
      { user_id: 'u2', account_id: 'acct-2', full_name: 'Other', email: 'o@y.com', account_role: 'admin', created_at: '2026-01-02' },
    ]);
    h.db = db;
    h.scopes = ['members:read'];
  });
  it('lists this account\'s team with the fields needed for assignment', async () => {
    const res = await GET(new Request('https://x.test/api/v1/members'));
    expect((await res.json()).data).toEqual([{ user_id: 'u1', name: 'Aiman', email: 'a@x.com', role: 'owner', joined_at: '2026-01-01' }]);
  });
  it('needs members:read', async () => {
    h.scopes = [];
    expect((await GET(new Request('https://x.test/api/v1/members'))).status).toBe(403);
  });
});
