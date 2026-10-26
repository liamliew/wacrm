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

import { PATCH } from './route';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const AGENT = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
let db: FakeDb;
const patch = (id: string, body: unknown) =>
  PATCH(new Request('https://x.test/api/v1/conversations/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const mine = () => db.rows('conversations').find((c) => c.id === C1)!;

beforeEach(() => {
  db = new FakeDb();
  db.seed('conversations', [
    { id: C1, account_id: 'acct-1', contact_id: 'ct', status: 'open', assigned_agent_id: null, unread_count: 4, ai_autoreply_disabled: true, ai_reply_count: 3, ai_handoff_summary: 'note', created_at: 't', updated_at: 't' },
    { id: C2, account_id: 'acct-2', contact_id: 'ct2', status: 'open', assigned_agent_id: null, unread_count: 9, ai_autoreply_disabled: false, ai_reply_count: 0, ai_handoff_summary: null, created_at: 't', updated_at: 't' },
  ]);
  db.seed('profiles', [{ user_id: AGENT, account_id: 'acct-1' }, { user_id: STRANGER, account_id: 'acct-2' }]);
  h.db = db;
  h.scopes = ['conversations:write'];
});

describe('PATCH /api/v1/conversations/{id}', () => {
  it('changes status and clears unread', async () => {
    const res = await patch(C1, { status: 'closed', mark_read: true });
    expect(res.status).toBe(200);
    expect(mine()).toMatchObject({ status: 'closed', unread_count: 0 });
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'conversation.update', resource_id: C1 });
    expect((await res.json()).data).toMatchObject({ id: C1, status: 'closed', unread_count: 0, ai_paused: true });
  });

  it('assigns a team member of this account and can unassign', async () => {
    expect((await patch(C1, { assigned_agent_id: AGENT })).status).toBe(200);
    expect(mine().assigned_agent_id).toBe(AGENT);
    expect((await patch(C1, { assigned_agent_id: null })).status).toBe(200);
    expect(mine().assigned_agent_id).toBeNull();
  });

  it('refuses to assign someone from another account', async () => {
    expect((await patch(C1, { assigned_agent_id: STRANGER })).status).toBe(400);
    expect(mine().assigned_agent_id).toBeNull();
  });

  it('pauses the AI without touching anything else', async () => {
    db.rows('conversations')[0].ai_autoreply_disabled = false;
    await patch(C1, { ai_paused: true });
    expect(mine()).toMatchObject({ ai_autoreply_disabled: true, ai_reply_count: 3, ai_handoff_summary: 'note' });
  });

  it('hands the thread back to the bot: resets the count, clears the note and releases the assignee', async () => {
    db.rows('conversations')[0].assigned_agent_id = AGENT;
    expect((await patch(C1, { ai_paused: false })).status).toBe(200);
    expect(mine()).toMatchObject({ ai_autoreply_disabled: false, ai_reply_count: 0, ai_handoff_summary: null, assigned_agent_id: null });
  });

  it('keeps an explicit assignee when resuming in the same call', async () => {
    await patch(C1, { ai_paused: false, assigned_agent_id: AGENT });
    expect(mine()).toMatchObject({ ai_autoreply_disabled: false, assigned_agent_id: AGENT });
  });

  it('cannot touch another account\'s conversation', async () => {
    expect((await patch(C2, { status: 'closed' })).status).toBe(404);
    expect(db.rows('conversations').find((c) => c.id === C2)).toMatchObject({ status: 'open', unread_count: 9 });
    expect((await patch('nope', { status: 'closed' })).status).toBe(404);
  });

  it('validates the body', async () => {
    for (const body of [{}, { status: 'archived' }, { assigned_agent_id: 'x' }, { ai_paused: 'yes' }, { mark_read: 1 }, { account_id: 'acct-2' }, { contact_id: 'x' }]) {
      expect((await patch(C1, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('needs conversations:write', async () => {
    h.scopes = ['conversations:read'];
    expect((await patch(C1, { status: 'closed' })).status).toBe(403);
    expect(mine().status).toBe('open');
  });
});
