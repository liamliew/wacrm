import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '@/test/fake-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  scopes: [] as string[],
  ingested: [] as { id: string; content: string }[],
  ingestResult: { keywordOnly: false, embedError: null } as { keywordOnly: boolean; embedError: unknown },
  ingestThrows: false,
  keyState: { key: 'emb-key' as string | null, corrupt: false },
}));

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
vi.mock('@/lib/ai/config', () => ({ loadEmbeddingsKey: async () => h.keyState }));
vi.mock('@/lib/ai/knowledge', () => ({
  ingestDocument: async (_db: unknown, _acct: string, _cfg: unknown, id: string, content: string) => {
    if (h.ingestThrows) throw new Error('db down');
    h.ingested.push({ id, content });
    return h.ingestResult;
  },
}));

import { GET as list, POST as create } from './route';
import { GET as read, PATCH as edit, DELETE as remove } from './[id]/route';
import { POST as reindex } from './reindex/route';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
let db: FakeDb;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const r = (method: string, body?: unknown) =>
  new Request('https://x.test/api/v1/ai/knowledge', { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  db = new FakeDb();
  db.seed('ai_knowledge_documents', [
    { id: D1, account_id: 'acct-1', title: 'Returns', content: '30 days', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
    { id: D2, account_id: 'acct-2', title: 'Secret other', content: 'private', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  ]);
  h.db = db;
  h.scopes = ['knowledge:read', 'knowledge:write'];
  h.ingested = [];
  h.ingestResult = { keywordOnly: false, embedError: null };
  h.ingestThrows = false;
  h.keyState = { key: 'emb-key', corrupt: false };
});

describe('knowledge base via the API', () => {
  it('lists only this account\'s documents, without content', async () => {
    const body = await (await list(r('GET'))).json();
    expect(body.data.map((d: { id: string }) => d.id)).toEqual([D1]);
    expect(JSON.stringify(body)).not.toContain('private');
    expect(body.data[0]).not.toHaveProperty('content');
  });

  it('creates and indexes a document, attributing the key\'s creator, and audits without the content', async () => {
    const res = await create(r('POST', { title: 'Shipping', content: 'Ships in 2 days.' }));
    expect(res.status).toBe(201);
    const row = db.rows('ai_knowledge_documents').find((d) => d.title === 'Shipping')!;
    expect(row).toMatchObject({ account_id: 'acct-1', created_by: 'user-1', content: 'Ships in 2 days.' });
    expect(h.ingested).toEqual([{ id: row.id, content: 'Ships in 2 days.' }]);
    const audit = db.rows('api_audit_log')[0];
    expect(audit).toMatchObject({ action: 'knowledge.create', resource_id: row.id });
    expect(JSON.stringify(audit)).not.toContain('Ships in 2 days');
  });

  it('keeps the document and warns when indexing fails or embeds fail', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.ingestThrows = true;
    const failed = await create(r('POST', { title: 'A', content: 'b' }));
    expect(failed.status).toBe(201);
    expect((await failed.json()).data.warning).toContain('indexing failed');
    h.ingestThrows = false;
    h.ingestResult = { keywordOnly: true, embedError: new Error('rate') };
    const kw = (await (await create(r('POST', { title: 'B', content: 'c' }))).json()).data;
    expect(kw.keyword_only).toBe(true);
    h.ingestResult = { keywordOnly: false, embedError: null };
    h.keyState = { key: null, corrupt: true };
    expect((await (await create(r('POST', { title: 'C', content: 'd' }))).json()).data.warning).toContain('could not be decrypted');
    expect(db.rows('ai_knowledge_documents')).toHaveLength(5);
    err.mockRestore();
  });

  it('validates input and rejects unknown fields', async () => {
    for (const body of [{}, { title: 'x' }, { content: 'x' }, { title: ' ', content: 'x' }, { title: 'x', content: '  ' }, { title: 'x', content: 'y'.repeat(100_001) }, { title: 'x', content: 'y', account_id: 'acct-2' }]) {
      expect((await create(r('POST', body))).status, JSON.stringify(body).slice(0, 50)).toBe(400);
    }
    expect(db.rows('ai_knowledge_documents')).toHaveLength(2);
  });

  it('reads a document with content, but not another account\'s', async () => {
    expect((await (await read(r('GET'), ctx(D1))).json()).data.content).toBe('30 days');
    expect((await read(r('GET'), ctx(D2))).status).toBe(404);
    expect((await read(r('GET'), ctx('nope'))).status).toBe(404);
  });

  it('reindexes only when the content changes, never touching other accounts', async () => {
    expect((await edit(r('PATCH', { title: 'Returns policy' }), ctx(D1))).status).toBe(200);
    expect(h.ingested).toHaveLength(0);
    expect((await edit(r('PATCH', { content: '14 days' }), ctx(D1))).status).toBe(200);
    expect(h.ingested).toEqual([{ id: D1, content: '14 days' }]);
    expect((await edit(r('PATCH', { content: 'hacked' }), ctx(D2))).status).toBe(404);
    expect(db.rows('ai_knowledge_documents').find((d) => d.id === D2)!.content).toBe('private');
    expect((await edit(r('PATCH', {}), ctx(D1))).status).toBe(400);
  });

  it('deletes only within the account', async () => {
    expect((await remove(r('DELETE'), ctx(D2))).status).toBe(404);
    expect(db.rows('ai_knowledge_documents')).toHaveLength(2);
    expect((await remove(r('DELETE'), ctx(D1))).status).toBe(200);
    expect(db.rows('ai_knowledge_documents').map((d) => d.id)).toEqual([D2]);
  });

  it('reindex covers only this account and refuses with a corrupt embeddings key', async () => {
    const res = await reindex(r('POST'));
    expect((await res.json()).data).toMatchObject({ total: 1, reindexed: 1 });
    expect(h.ingested.map((i) => i.id)).toEqual([D1]);
    h.keyState = { key: null, corrupt: true };
    expect((await reindex(r('POST'))).status).toBe(409);
  });

  it('enforces scopes: read-only keys cannot write', async () => {
    h.scopes = ['knowledge:read'];
    expect((await list(r('GET'))).status).toBe(200);
    expect((await create(r('POST', { title: 'x', content: 'y' }))).status).toBe(403);
    expect((await edit(r('PATCH', { title: 'x' }), ctx(D1))).status).toBe(403);
    expect((await remove(r('DELETE'), ctx(D1))).status).toBe(403);
    expect((await reindex(r('POST'))).status).toBe(403);
    h.scopes = ['knowledge:write'];
    expect((await list(r('GET'))).status).toBe(403);
  });
});
