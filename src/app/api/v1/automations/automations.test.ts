import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '@/test/fake-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  scopes: [] as string[],
  inserted: [] as { id: string; steps: unknown[] }[],
  replaced: [] as { id: string; steps: unknown[] }[],
  stepsError: null as string | null,
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
vi.mock('@/lib/automations/steps-tree', () => ({
  insertSteps: async (id: string, steps: unknown[]) => { h.inserted.push({ id, steps }); return h.stepsError; },
  replaceSteps: async (id: string, steps: unknown[]) => { h.replaced.push({ id, steps }); return h.stepsError; },
  loadStepsTree: async () => [
    { step_type: 'send_message', step_config: { text: 'hello' } },
    { step_type: 'send_webhook', step_config: { url: 'https://hook.test', headers: { Authorization: 'Bearer SECRET' } } },
  ],
}));

import { GET as list, POST as create } from './route';
import * as item from './[id]/route';
import { POST as duplicate } from './[id]/duplicate/route';
import { GET as logs } from './[id]/logs/route';
import { GET as templates } from './templates/route';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
let db: FakeDb;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = 'https://x.test/api/v1/automations') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const keyword = { keywords: ['hello'], match_type: 'contains' };
const sendHi = { step_type: 'send_message', step_config: { message: 'Hi!' } };

beforeEach(() => {
  db = new FakeDb();
  db.seed('accounts', [{ id: 'acct-1', owner_user_id: 'owner-1' }]);
  db.seed('automations', [
    { id: A1, account_id: 'acct-1', name: 'Mine', description: null, trigger_type: 'keyword_match', trigger_config: keyword, is_active: false, created_at: '2026-01-02' },
    { id: A2, account_id: 'acct-2', name: 'Theirs', description: null, trigger_type: 'keyword_match', trigger_config: keyword, is_active: true, created_at: '2026-01-01' },
  ]);
  db.seed('automation_logs', [
    { id: 'l1', automation_id: A1, account_id: 'acct-1', status: 'success', created_at: '2026-01-03' },
    { id: 'l2', automation_id: A2, account_id: 'acct-2', status: 'failed', created_at: '2026-01-03' },
  ]);
  h.db = db;
  h.scopes = ['automations:read', 'automations:write'];
  h.inserted = [];
  h.replaced = [];
  h.stepsError = null;
});

describe('automations', () => {
  it('lists only this account\'s automations', async () => {
    expect((await (await list(req('GET'))).json()).data.map((a: { name: string }) => a.name)).toEqual(['Mine']);
  });

  it('creates an inactive draft by default, with steps, attributed to the owner', async () => {
    const res = await create(req('POST', { name: 'Greeter', trigger_type: 'keyword_match', trigger_config: keyword, steps: [sendHi] }));
    expect(res.status).toBe(201);
    const row = db.rows('automations').find((a) => a.name === 'Greeter')!;
    expect(row).toMatchObject({ account_id: 'acct-1', user_id: 'owner-1', is_active: false });
    expect(h.inserted).toEqual([{ id: row.id, steps: [sendHi] }]);
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'automation.create', summary: { fields: ['name', 'trigger_type', 'trigger_config', 'steps'], is_active: false } });
  });

  it('refuses to create an incomplete automation as ACTIVE, listing the issues', async () => {
    const res = await create(req('POST', { name: 'Broken', trigger_type: 'keyword_match', trigger_config: {}, is_active: true, steps: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(db.rows('automations')).toHaveLength(2);
  });

  it('creates from a template, and refuses template + steps together or an unknown template', async () => {
    const slug = (await (await templates(req('GET'))).json()).data[0].slug;
    expect((await create(req('POST', { template: slug }))).status).toBe(201);
    expect((await create(req('POST', { template: slug, steps: [sendHi] }))).status).toBe(400);
    expect((await create(req('POST', { template: 'nope' }))).status).toBe(400);
  });

  it('rolls back the automation when its steps cannot be saved', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.stepsError = 'boom';
    const res = await create(req('POST', { name: 'Half', trigger_type: 'keyword_match', trigger_config: keyword, steps: [sendHi] }));
    expect(res.status).toBe(500);
    expect(db.rows('automations').some((a) => a.name === 'Half')).toBe(false);
    err.mockRestore();
  });

  it('refuses webhook steps from the API', async () => {
    const res = await create(req('POST', { name: 'Leak', trigger_type: 'keyword_match', trigger_config: keyword, steps: [{ step_type: 'send_webhook', step_config: { url: 'https://evil.test' } }] }));
    expect(res.status).toBe(400);
    expect(db.rows('automations').some((a) => a.name === 'Leak')).toBe(false);
  });

  it('validates input', async () => {
    for (const body of [{}, { name: 'x' }, { name: 'x', trigger_type: 'cron' }, { name: 'x', trigger_type: 'keyword_match', steps: [{ step_type: 'hack' }] }, { name: 'x', trigger_type: 'keyword_match', account_id: 'a' }]) {
      expect((await create(req('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('reads with its step tree, own account only', async () => {
    const body = await (await item.GET(req('GET'), ctx(A1))).json();
    expect(body.data.steps).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('SECRET'); // webhook credentials are never returned
    expect((await item.GET(req('GET'), ctx(A2))).status).toBe(404);
  });

  it('edits fields and replaces steps; foreign ids are untouched', async () => {
    expect((await item.PATCH(req('PATCH', { name: 'Renamed', steps: [sendHi] }), ctx(A1))).status).toBe(200);
    expect(db.rows('automations').find((a) => a.id === A1)!.name).toBe('Renamed');
    expect(h.replaced).toEqual([{ id: A1, steps: [sendHi] }]);
    expect((await item.PATCH(req('PATCH', { name: 'Pwn' }), ctx(A2))).status).toBe(404);
    expect(db.rows('automations').find((a) => a.id === A2)!.name).toBe('Theirs');
    expect((await item.PATCH(req('PATCH', {}), ctx(A1))).status).toBe(400);
  });

  it('refuses to activate an invalid automation, but activates a valid one', async () => {
    db.rows('automations')[0].trigger_config = {};
    const bad = await item.PATCH(req('PATCH', { is_active: true }), ctx(A1));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.issues.length).toBeGreaterThan(0);
    expect(db.rows('automations')[0].is_active).toBe(false);
    const ok = await item.PATCH(req('PATCH', { is_active: true, trigger_config: keyword }), ctx(A1));
    expect(ok.status).toBe(200);
    expect(db.rows('automations')[0].is_active).toBe(true);
  });

  it('duplicates as an inactive copy within the account only', async () => {
    const res = await duplicate(req('POST'), ctx(A1));
    expect(res.status).toBe(201);
    expect(db.rows('automations').filter((a) => a.account_id === 'acct-1')).toHaveLength(2);
    expect(db.rows('automations').find((a) => a.id !== A1 && a.account_id === 'acct-1')).toMatchObject({ is_active: false });
    expect((await duplicate(req('POST'), ctx(A2))).status).toBe(404);
    expect(db.rows('automations').filter((a) => a.account_id === 'acct-2')).toHaveLength(1);
  });

  it('deletes only within the account, and reads logs only for own automations', async () => {
    expect((await item.DELETE(req('DELETE'), ctx(A2))).status).toBe(404);
    expect((await (await logs(req('GET'), ctx(A1))).json()).data.map((l: { id: string }) => l.id)).toEqual(['l1']);
    expect((await logs(req('GET'), ctx(A2))).status).toBe(404);
    expect((await item.DELETE(req('DELETE'), ctx(A1))).status).toBe(200);
    expect(db.rows('automations').map((a) => a.id)).toEqual([A2]);
  });

  it('enforces scopes', async () => {
    h.scopes = ['automations:read'];
    expect((await create(req('POST', { name: 'x', trigger_type: 'keyword_match' }))).status).toBe(403);
    expect((await item.PATCH(req('PATCH', { name: 'x' }), ctx(A1))).status).toBe(403);
    expect((await item.DELETE(req('DELETE'), ctx(A1))).status).toBe(403);
    expect((await duplicate(req('POST'), ctx(A1))).status).toBe(403);
  });
});
