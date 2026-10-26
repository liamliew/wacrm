import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '@/test/fake-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  scopes: [] as string[],
  submitCalls: [] as { accountId: string; userId: string }[],
  syncCalls: 0,
  gen: { text: 'Sure!', handoff: false } as { text: string; handoff: boolean },
  genArgs: [] as { systemPrompt: string; messages: unknown[] }[],
  aiConfig: { systemPrompt: 'SAVED PROMPT', provider: 'openai' } as Record<string, unknown> | null,
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
vi.mock('@/lib/whatsapp/template-submit', async () => {
  const { NextResponse } = await import('next/server');
  return {
    submitTemplate: async (_req: Request, auth: { accountId: string; userId: string }) => {
      h.submitCalls.push({ accountId: auth.accountId, userId: auth.userId });
      return NextResponse.json({ success: true, template: { id: 't1' }, dry_run: false });
    },
  };
});
vi.mock('@/lib/whatsapp/template-sync', async () => {
  const { NextResponse } = await import('next/server');
  return {
    syncTemplates: async () => {
      h.syncCalls += 1;
      return NextResponse.json({ error: 'Meta API returned 500' }, { status: 502 });
    },
  };
});
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => h.aiConfig, loadEmbeddingsKey: async () => ({ key: null, corrupt: false }) }));
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: async () => ['excerpt 1', 'excerpt 2'], ingestDocument: async () => ({ keywordOnly: false, embedError: null }) }));
vi.mock('@/lib/ai/generate', () => ({
  generateReply: async (a: { systemPrompt: string; messages: unknown[] }) => { h.genArgs.push(a); return h.gen; },
}));

import { GET as listQr, POST as createQr } from './quick-replies/route';
import * as qrItem from './quick-replies/[id]/route';
import { GET as listTemplates, POST as submit } from './templates/route';
import { POST as sync } from './templates/sync/route';
import { GET as audit } from './audit/route';
import { DELETE as deleteContact } from './contacts/[id]/route';
import * as notes from './contacts/[id]/notes/route';
import { DELETE as deleteNote } from './contacts/[id]/notes/[noteId]/route';
import * as cfields from './contacts/[id]/custom-fields/route';
import { POST as preview } from './ai/handoff/preview/route';
import { POST as playground } from './ai/playground/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const Q1 = U(1), Q2 = U(2), CT1 = U(3), CT2 = U(4), N1 = U(5), N2 = U(6), FLD1 = U(7), FLD2 = U(8);
let db: FakeDb;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const noteCtx = (id: string, noteId: string) => ({ params: Promise.resolve({ id, noteId }) });
const req = (method: string, body?: unknown, url = 'https://x.test/api/v1/x') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  __resetRateLimitForTests();
  db = new FakeDb();
  db.seed('accounts', [{ id: 'acct-1', owner_user_id: 'owner-1' }]);
  db.seed('quick_replies', [
    { id: Q1, account_id: 'acct-1', user_id: 'o', title: 'Hello', kind: 'text', content_text: 'Hi!', interactive_payload: null, created_at: '2026-01-02', updated_at: 'x' },
    { id: Q2, account_id: 'acct-2', user_id: 'o2', title: 'Theirs', kind: 'text', content_text: 'secret', interactive_payload: null, created_at: '2026-01-01', updated_at: 'x' },
  ]);
  db.seed('contacts', [{ id: CT1, account_id: 'acct-1' }, { id: CT2, account_id: 'acct-2' }]);
  db.seed('contact_notes', [
    { id: N1, contact_id: CT1, account_id: 'acct-1', user_id: 'o', note_text: 'VIP', created_at: '2026-01-02' },
    { id: N2, contact_id: CT2, account_id: 'acct-2', user_id: 'o2', note_text: 'Other', created_at: '2026-01-02' },
  ]);
  db.seed('custom_fields', [
    { id: FLD1, account_id: 'acct-1', field_name: 'Plan' },
    { id: FLD2, account_id: 'acct-2', field_name: 'Theirs' },
  ]);
  h.db = db;
  h.scopes = ['settings:read', 'settings:write', 'templates:read', 'templates:write', 'audit:read', 'contacts:read', 'contacts:write', 'contacts:delete', 'ai:read'];
  h.submitCalls = [];
  h.syncCalls = 0;
  h.gen = { text: 'Sure!', handoff: false };
  h.genArgs = [];
  h.aiConfig = { systemPrompt: 'SAVED PROMPT', provider: 'openai' };
});

describe('quick replies', () => {
  const buttons = { kind: 'buttons', body: 'Pick one', buttons: [{ id: 'a', title: 'Yes' }, { id: 'b', title: 'No' }] };

  it('lists own account only', async () => {
    expect((await (await listQr(req('GET'))).json()).data.map((q: { title: string }) => q.title)).toEqual(['Hello']);
  });
  it('creates text replies and valid interactive ones, nulling the unused field', async () => {
    const t = await createQr(req('POST', { title: 'Bye', content_text: 'Goodbye' }));
    expect(t.status).toBe(201);
    expect(db.rows('quick_replies').find((q) => q.title === 'Bye')).toMatchObject({ kind: 'text', content_text: 'Goodbye', interactive_payload: null, account_id: 'acct-1' });
    const i = await createQr(req('POST', { title: 'Menu', kind: 'interactive', interactive_payload: buttons, content_text: 'ignored' }));
    expect(i.status).toBe(201);
    expect(db.rows('quick_replies').find((q) => q.title === 'Menu')).toMatchObject({ kind: 'interactive', content_text: null });
  });
  it('rejects empty text, bad interactive payloads and unknown fields', async () => {
    for (const body of [{ title: 'x' }, { title: 'x', content_text: '  ' }, { title: 'x', kind: 'interactive' }, { title: 'x', kind: 'interactive', interactive_payload: { kind: 'buttons' } }, { title: 'x', content_text: 'y', account_id: 'a' }]) {
      expect((await createQr(req('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
  });
  it('edits an own reply, switches kind cleanly, and cannot touch another account\'s', async () => {
    expect((await qrItem.PATCH(req('PATCH', { content_text: 'Hey!' }), ctx(Q1))).status).toBe(200);
    expect(db.rows('quick_replies').find((q) => q.id === Q1)!.content_text).toBe('Hey!');
    expect((await qrItem.PATCH(req('PATCH', { kind: 'interactive', interactive_payload: buttons }), ctx(Q1))).status).toBe(200);
    expect(db.rows('quick_replies').find((q) => q.id === Q1)).toMatchObject({ kind: 'interactive', content_text: null });
    expect((await qrItem.PATCH(req('PATCH', { kind: 'text' }), ctx(Q1))).status).toBe(400); // text with no content_text
    expect((await qrItem.PATCH(req('PATCH', { title: 'Pwn' }), ctx(Q2))).status).toBe(404);
    expect((await qrItem.DELETE!(req('DELETE'), ctx(Q2))).status).toBe(404);
    expect(db.rows('quick_replies').find((q) => q.id === Q2)!.title).toBe('Theirs');
  });
});

describe('templates', () => {
  it('submits through the shared code as the account\'s audit user, and audits', async () => {
    const res = await submit(req('POST', { name: 'promo', category: 'Marketing', language: 'en_US', body_text: 'Hi' }));
    expect(res.status).toBe(200);
    expect(h.submitCalls).toEqual([{ accountId: 'acct-1', userId: 'owner-1' }]);
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'template.submit' });
  });
  it('maps a Meta failure to the public error envelope and does not audit it', async () => {
    const res = await sync(req('POST'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'meta_error', message: 'Meta API returned 500' } });
    expect(db.rows('api_audit_log')).toHaveLength(0);
  });
  it('lists only own templates and needs the right scopes', async () => {
    db.seed('message_templates', [{ id: U(9), account_id: 'acct-1', name: 'a', created_at: '2026-01-01' }, { id: U(1) + 'x', account_id: 'acct-2', name: 'b', created_at: '2026-01-01' }]);
    expect((await (await listTemplates(req('GET'))).json()).data).toHaveLength(1);
    h.scopes = ['templates:read'];
    expect((await submit(req('POST', {}))).status).toBe(403);
    expect((await sync(req('POST'))).status).toBe(403);
  });
});

describe('audit log', () => {
  it('lists only this account\'s entries', async () => {
    db.seed('api_audit_log', [
      { id: U(1), account_id: 'acct-1', api_key_id: 'k', action: 'tag.create', resource_type: 'tag', resource_id: 'x', summary: { fields: ['name'] }, created_at: '2026-01-02' },
      { id: U(2), account_id: 'acct-2', api_key_id: 'k', action: 'secret', resource_type: 'tag', resource_id: 'x', summary: {}, created_at: '2026-01-03' },
    ]);
    const body = await (await audit(req('GET'))).json();
    expect(body.data.map((e: { action: string }) => e.action)).toEqual(['tag.create']);
    h.scopes = [];
    expect((await audit(req('GET'))).status).toBe(403);
  });
});

describe('contacts: delete, notes, custom fields', () => {
  it('deletes only within the account and audits', async () => {
    expect((await deleteContact(req('DELETE'), ctx(CT2))).status).toBe(404);
    expect(db.rows('contacts')).toHaveLength(2);
    expect((await deleteContact(req('DELETE'), ctx(CT1))).status).toBe(200);
    expect(db.rows('contacts').map((c) => c.id)).toEqual([CT2]);
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'contact.delete', resource_id: CT1 });
    h.scopes = ['contacts:write'];
    expect((await deleteContact(req('DELETE'), ctx(CT2))).status).toBe(403);
  });
  it('lists, adds and removes notes only on own contacts', async () => {
    expect((await (await notes.GET(req('GET'), ctx(CT1))).json()).data.map((n: { note_text: string }) => n.note_text)).toEqual(['VIP']);
    expect((await notes.GET(req('GET'), ctx(CT2))).status).toBe(404);
    expect((await notes.POST(req('POST', { note_text: 'Called back' }), ctx(CT1))).status).toBe(201);
    expect(db.rows('contact_notes').find((n) => n.note_text === 'Called back')).toMatchObject({ account_id: 'acct-1', contact_id: CT1, user_id: 'owner-1' });
    expect((await notes.POST(req('POST', { note_text: 'x' }), ctx(CT2))).status).toBe(404);
    expect((await notes.POST(req('POST', { note_text: ' ' }), ctx(CT1))).status).toBe(400);
    expect((await deleteNote(req('DELETE'), noteCtx(CT1, N2))).status).toBe(404);
    expect((await deleteNote(req('DELETE'), noteCtx(CT2, N2))).status).toBe(404);
    expect((await deleteNote(req('DELETE'), noteCtx(CT1, N1))).status).toBe(200);
    const left = db.rows('contact_notes').map((n) => n.id);
    expect(left).toContain(N2);
    expect(left).not.toContain(N1);
  });
  it('sets and clears custom field values, only with this account\'s fields on its contacts', async () => {
    const set = await cfields.PUT(req('PUT', { values: { [FLD1]: 'Gold' } }), ctx(CT1));
    expect(set.status).toBe(200);
    expect((await set.json()).data).toEqual([{ field_id: FLD1, field_name: 'Plan', value: 'Gold' }]);
    expect((await cfields.PUT(req('PUT', { values: { [FLD1]: 'Silver' } }), ctx(CT1))).status).toBe(200);
    expect(db.rows('contact_custom_values')).toHaveLength(1);
    expect(db.rows('contact_custom_values')[0].value).toBe('Silver');
    expect((await cfields.PUT(req('PUT', { values: { [FLD1]: null } }), ctx(CT1))).status).toBe(200);
    expect(db.rows('contact_custom_values')).toHaveLength(0);
    expect((await cfields.PUT(req('PUT', { values: { [FLD2]: 'x' } }), ctx(CT1))).status).toBe(400);
    expect((await cfields.PUT(req('PUT', { values: { [FLD1]: 'x' } }), ctx(CT2))).status).toBe(404);
    for (const body of [{}, { values: {} }, { values: [] }, { values: { nope: 'x' } }, { values: { [FLD1]: 5 } }, { other: 1 }]) {
      expect((await cfields.PUT(req('PUT', body), ctx(CT1))).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('AI handoff preview', () => {
  const hours = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map((d) => [d, { open: !['sat','sun'].includes(d), start: '09:00', end: '18:00' }]));
  beforeEach(() => {
    db.seed('ai_configs', [{ account_id: 'acct-1', handoff_timezone: 'Asia/Kuala_Lumpur', handoff_hours: hours, handoff_message_enabled: true, handoff_open_message: 'OPEN', handoff_closed_message: 'CLOSED {{next_open_day}} {{next_open_time}}', handoff_cap_message: 'CAP' }]);
  });
  it('shows the message for a given time without sending anything', async () => {
    const closed = await (await preview(req('POST', { time: '2026-10-26T20:00' }))).json();
    expect(closed.data).toMatchObject({ team_open: false, which: 'closed', would_send: true, message: 'CLOSED tomorrow 9am' });
    const open = await (await preview(req('POST', { time: '2026-10-26T10:00' }))).json();
    expect(open.data).toMatchObject({ team_open: true, which: 'open', message: 'OPEN' });
    const cap = await (await preview(req('POST', { time: '2026-10-26T10:00', reason: 'cap' }))).json();
    expect(cap.data).toMatchObject({ which: 'cap', message: 'CAP' });
  });
  it('works with an empty body, rejects bad input, and 409s without a provider', async () => {
    expect((await preview(new Request('https://x.test', { method: 'POST' }))).status).toBe(200);
    for (const body of [{ time: 'tomorrow' }, { reason: 'other' }, { extra: 1 }]) {
      expect((await preview(req('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
    db.tables.ai_configs = [];
    expect((await preview(req('POST', {}))).status).toBe(409);
  });
});

describe('AI playground', () => {
  const msgs = [{ role: 'user', content: 'Do you ship to Penang?' }];
  it('tests the saved agent without saving anything', async () => {
    const res = await playground(req('POST', { messages: msgs }));
    expect((await res.json()).data).toMatchObject({ reply: 'Sure!', would_hand_off: false, used_prompt_override: false, knowledge_excerpts_used: 2 });
    expect(h.genArgs[0].systemPrompt).toContain('SAVED PROMPT');
    expect(db.rows('ai_configs')).toHaveLength(0);
  });
  it('tries a candidate prompt for one call only', async () => {
    const res = await playground(req('POST', { messages: msgs, system_prompt: 'CANDIDATE PROMPT' }));
    expect((await res.json()).data.used_prompt_override).toBe(true);
    expect(h.genArgs[0].systemPrompt).toContain('CANDIDATE PROMPT');
    expect(h.genArgs[0].systemPrompt).not.toContain('SAVED PROMPT');
  });
  it('validates input, answers 409 without an agent, and is rate limited', async () => {
    for (const body of [{}, { messages: 'x' }, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: msgs, system_prompt: 5 }, { messages: msgs, extra: 1 }]) {
      expect((await playground(req('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
    h.aiConfig = null;
    expect((await playground(req('POST', { messages: msgs }))).status).toBe(409);
    h.aiConfig = { systemPrompt: null };
    let last = 200;
    for (let i = 0; i < 25; i++) last = (await playground(req('POST', { messages: msgs }))).status;
    expect(last).toBe(429);
  });
  it('needs ai:read', async () => {
    h.scopes = [];
    expect((await playground(req('POST', { messages: msgs }))).status).toBe(403);
  });
});
