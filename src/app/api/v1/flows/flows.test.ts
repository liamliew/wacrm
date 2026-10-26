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

import { GET as listFlows, POST as createFlow } from './route';
import * as flowItem from './[id]/route';
import { POST as setStatus } from './[id]/status/route';
import { POST as validate } from './[id]/validate/route';
import { GET as runs } from './[id]/runs/route';
import { GET as templates } from './templates/route';

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
let db: FakeDb;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = 'https://x.test/api/v1/flows') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const goodNodes = [
  { node_key: 'start', node_type: 'start', config: { next: 'hello' } },
  { node_key: 'hello', node_type: 'send_message', config: { text: 'Hi there', next: 'end' } },
  { node_key: 'end', node_type: 'end', config: {} },
];

beforeEach(() => {
  db = new FakeDb();
  db.seed('accounts', [{ id: 'acct-1', owner_user_id: 'owner-1' }]);
  db.seed('flows', [
    { id: F1, account_id: 'acct-1', name: 'Mine', status: 'draft', trigger_type: 'keyword', trigger_config: {}, entry_node_id: null, created_at: '2026-01-02' },
    { id: F2, account_id: 'acct-2', name: 'Theirs', status: 'active', trigger_type: 'keyword', trigger_config: {}, entry_node_id: null, created_at: '2026-01-01' },
  ]);
  db.seed('flow_nodes', [{ id: 'n1', flow_id: F1, node_key: 'start', node_type: 'start', config: {}, position_x: 0, position_y: 0, created_at: 'a' }]);
  db.seed('flow_runs', [
    { id: 'r1', flow_id: F1, account_id: 'acct-1', status: 'active', started_at: '2026-01-03' },
    { id: 'r2', flow_id: F2, account_id: 'acct-2', status: 'active', started_at: '2026-01-03' },
  ]);
  db.rpcHandlers.replace_flow_nodes_for_account = (args) => {
    const flow = db.rows('flows').find((f) => f.id === args.p_flow_id);
    if (!flow || flow.account_id !== args.p_account_id) return { data: null, error: { message: 'Flow not found' } };
    db.tables.flow_nodes = db.rows('flow_nodes').filter((n) => n.flow_id !== args.p_flow_id);
    for (const n of args.p_nodes as Record<string, unknown>[]) db.rows('flow_nodes').push({ id: db.nextId(), flow_id: args.p_flow_id, created_at: 'z', ...n });
    return { data: 0, error: null };
  };
  h.db = db;
  h.scopes = ['flows:read', 'flows:write'];
});

describe('flows: create and list', () => {
  it('lists only this account\'s flows', async () => {
    const body = await (await listFlows(req('GET'))).json();
    expect(body.data.map((f: { name: string }) => f.name)).toEqual(['Mine']);
  });

  it('creates an empty DRAFT flow in the key\'s account, even if the caller asks for active', async () => {
    const res = await createFlow(req('POST', { name: 'Welcome', trigger_type: 'first_inbound_message' }));
    expect(res.status).toBe(201);
    expect(db.rows('flows').find((f) => f.name === 'Welcome')).toMatchObject({ status: 'draft', account_id: 'acct-1', user_id: 'owner-1' });
    expect((await createFlow(req('POST', { name: 'X', status: 'active' }))).status).toBe(400);
  });

  it('clones a built-in template with its nodes, and refuses an unknown one', async () => {
    const list = await (await templates(req('GET'))).json();
    expect(list.data.length).toBeGreaterThan(0);
    const slug = list.data[0].slug;
    const res = await createFlow(req('POST', { template_slug: slug }));
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(db.rows('flow_nodes').filter((n) => n.flow_id === created.id).length).toBeGreaterThan(0);
    expect((await createFlow(req('POST', { template_slug: 'nope' }))).status).toBe(400);
  });

  it('validates input', async () => {
    for (const body of [{}, { name: '' }, { name: 'x', trigger_type: 'cron' }, { name: 'x', trigger_config: [] }, { name: 'x', account_id: 'a' }]) {
      expect((await createFlow(req('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('flows: read, edit, delete', () => {
  it('reads flow and nodes, own account only', async () => {
    const res = await flowItem.GET(req('GET'), ctx(F1));
    expect((await res.json()).data.nodes).toHaveLength(1);
    expect((await flowItem.GET(req('GET'), ctx(F2))).status).toBe(404);
  });

  it('replaces nodes through the account-scoped function and updates fields', async () => {
    const res = await flowItem.PUT(req('PUT', { name: 'Renamed', entry_node_id: 'start', nodes: goodNodes }), ctx(F1));
    expect(res.status).toBe(200);
    expect(db.rpcLog[0]).toMatchObject({ name: 'replace_flow_nodes_for_account', args: { p_account_id: 'acct-1', p_flow_id: F1 } });
    expect(db.rows('flow_nodes').filter((n) => n.flow_id === F1)).toHaveLength(3);
    expect(db.rows('flows').find((f) => f.id === F1)).toMatchObject({ name: 'Renamed', entry_node_id: 'start' });
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'flow.update', summary: { fields: ['name', 'entry_node_id', 'nodes'], node_count: 3 } });
  });

  it('can update only the nodes, and rejects an empty update', async () => {
    expect((await flowItem.PATCH(req('PATCH', { nodes: goodNodes }), ctx(F1))).status).toBe(200);
    expect((await flowItem.PATCH(req('PATCH', {}), ctx(F1))).status).toBe(400);
  });

  it('cannot edit or replace nodes of another account\'s flow', async () => {
    expect((await flowItem.PUT(req('PUT', { name: 'Pwn', nodes: goodNodes }), ctx(F2))).status).toBe(404);
    expect(db.rpcLog).toHaveLength(0);
    expect(db.rows('flows').find((f) => f.id === F2)!.name).toBe('Theirs');
  });

  it('rejects malformed nodes before touching anything', async () => {
    expect((await flowItem.PUT(req('PUT', { nodes: [{ node_key: 'a', node_type: 'teleport' }] }), ctx(F1))).status).toBe(400);
    expect(db.rpcLog).toHaveLength(0);
  });

  it('keeps an ACTIVE flow valid: refuses a save that would break it with 422 + issues', async () => {
    db.rows('flows')[0].status = 'active';
    const res = await flowItem.PUT(req('PUT', { nodes: [{ node_key: 'solo', node_type: 'send_message', config: {} }] }), ctx(F1));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(db.rpcLog).toHaveLength(0);
  });

  it('deletes only within the account', async () => {
    expect((await flowItem.DELETE(req('DELETE'), ctx(F2))).status).toBe(404);
    expect(db.rows('flows')).toHaveLength(2);
    expect((await flowItem.DELETE(req('DELETE'), ctx(F1))).status).toBe(200);
    expect(db.rows('flows').map((f) => f.id)).toEqual([F2]);
  });
});

describe('flows: status, validate, runs', () => {
  it('refuses to activate an incomplete flow, and reports why', async () => {
    const res = await setStatus(req('POST', { status: 'active' }), ctx(F1));
    expect(res.status).toBe(422);
    expect((await res.json()).error.issues.length).toBeGreaterThan(0);
    expect(db.rows('flows').find((f) => f.id === F1)!.status).toBe('draft');
    const check = await (await validate(req('POST'), ctx(F1))).json();
    expect(check.data.can_activate).toBe(false);
  });

  it('archiving a flow cancels its active runs, only in this account', async () => {
    expect((await setStatus(req('POST', { status: 'archived' }), ctx(F1))).status).toBe(200);
    expect(db.rows('flow_runs').find((r) => r.id === 'r1')).toMatchObject({ status: 'cancelled', end_reason: 'flow_archived' });
    expect(db.rows('flow_runs').find((r) => r.id === 'r2')!.status).toBe('active');
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'flow.status', summary: { status: 'archived', fields: [] } });
  });

  it('validates the status value and the flow\'s account', async () => {
    expect((await setStatus(req('POST', { status: 'paused' }), ctx(F1))).status).toBe(400);
    expect((await setStatus(req('POST', { status: 'draft' }), ctx(F2))).status).toBe(404);
    expect((await validate(req('POST'), ctx(F2))).status).toBe(404);
  });

  it('lists runs of an own flow only', async () => {
    expect((await (await runs(req('GET'), ctx(F1))).json()).data.map((r: { id: string }) => r.id)).toEqual(['r1']);
    expect((await runs(req('GET'), ctx(F2))).status).toBe(404);
  });

  it('enforces scopes', async () => {
    h.scopes = ['flows:read'];
    expect((await createFlow(req('POST', { name: 'x' }))).status).toBe(403);
    expect((await flowItem.PUT(req('PUT', { name: 'x' }), ctx(F1))).status).toBe(403);
    expect((await flowItem.DELETE(req('DELETE'), ctx(F1))).status).toBe(403);
    expect((await setStatus(req('POST', { status: 'draft' }), ctx(F1))).status).toBe(403);
    h.scopes = ['flows:write'];
    expect((await listFlows(req('GET'))).status).toBe(403);
  });
});
