import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '@/test/fake-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  scopes: [] as string[],
  validateCalls: [] as { model: string; apiKey: string; provider: string }[],
  validateError: null as null | { message: string; code: string; status: number },
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
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}`, encrypt: (v: string) => `enc:${v}` }));
vi.mock('@/lib/ai/validate', async () => {
  const { AiError } = await import('@/lib/ai/types');
  return {
    validateAiCredentials: async (c: { model: string; apiKey: string; provider: string }) => {
      h.validateCalls.push({ model: c.model, apiKey: c.apiKey, provider: c.provider });
      if (h.validateError) throw new AiError(h.validateError.message, { code: 'invalid_key', status: h.validateError.status });
    },
  };
});

import { GET, PATCH } from './route';

const AGENT = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
let db: FakeDb;

const patch = (body: unknown) =>
  PATCH(new Request('https://x.test/api/v1/ai/config', { method: 'PATCH', body: JSON.stringify(body) }));
const get = () => GET(new Request('https://x.test/api/v1/ai/config'));

const CONFIG = {
  account_id: 'acct-1', provider: 'openai', model: 'gpt-4o', base_url: null, api_key: 'enc-secret',
  embeddings_api_key: 'enc-emb', system_prompt: 'Be nice', is_active: true, auto_reply_enabled: true,
  auto_reply_max_per_conversation: 3, handoff_agent_id: null, handoff_timezone: 'Asia/Kuala_Lumpur',
  handoff_hours: null, handoff_message_enabled: false, handoff_open_message: null,
  handoff_closed_message: null, handoff_cap_message: null, updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  db = new FakeDb();
  db.seed('ai_configs', [{ ...CONFIG }, { ...CONFIG, account_id: 'acct-2', system_prompt: 'OTHER ACCOUNT' }]);
  db.seed('profiles', [{ user_id: AGENT, account_id: 'acct-1' }, { user_id: STRANGER, account_id: 'acct-2' }]);
  h.db = db;
  h.scopes = ['ai:read', 'ai:write'];
  h.validateCalls = [];
  h.validateError = null;
});

describe('GET /api/v1/ai/config', () => {
  it('returns this account\'s agent setup and never the keys', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      configured: true, provider: 'openai', model: 'gpt-4o', system_prompt: 'Be nice',
      is_active: true, auto_reply_max_per_conversation: 3, timezone: 'Asia/Kuala_Lumpur',
      has_provider_key: true, has_embeddings_key: true,
    });
    const text = JSON.stringify(data);
    expect(text).not.toContain('enc-secret');
    expect(text).not.toContain('enc-emb');
    expect(text).not.toContain('OTHER ACCOUNT');
    expect(data).not.toHaveProperty('api_key');
  });
  it('reports not configured', async () => {
    db.tables.ai_configs = [];
    expect((await (await get()).json()).data).toEqual({ configured: false });
  });
  it('needs ai:read', async () => {
    h.scopes = ['ai:write'];
    expect((await get()).status).toBe(403);
  });
});

describe('PATCH /api/v1/ai/config', () => {
  it('changes the prompt and switches, leaves other accounts alone, and audits field names only', async () => {
    const res = await patch({ system_prompt: 'You are Aisha. Never promise refunds.', auto_reply_enabled: false, auto_reply_max_per_conversation: 5 });
    expect(res.status).toBe(200);
    const mine = db.rows('ai_configs').find((r) => r.account_id === 'acct-1')!;
    expect(mine).toMatchObject({ system_prompt: 'You are Aisha. Never promise refunds.', auto_reply_enabled: false, auto_reply_max_per_conversation: 5 });
    expect(db.rows('ai_configs').find((r) => r.account_id === 'acct-2')!.system_prompt).toBe('OTHER ACCOUNT');
    const audit = db.rows('api_audit_log')[0];
    expect(audit).toMatchObject({ action: 'ai.config.update', account_id: 'acct-1' });
    expect(audit.summary).toEqual({ fields: ['system_prompt', 'auto_reply_enabled', 'auto_reply_max_per_conversation'] });
    expect(JSON.stringify(audit)).not.toContain('Aisha');
    expect(h.validateCalls).toHaveLength(0); // no model change → no provider call
  });

  it('can clear the prompt with null', async () => {
    expect((await patch({ system_prompt: null })).status).toBe(200);
    expect(db.rows('ai_configs')[0].system_prompt).toBeNull();
  });

  it('refuses to touch the provider, base URL or keys', async () => {
    for (const body of [{ api_key: 'sk-x' }, { provider: 'anthropic' }, { base_url: 'https://evil.test' }, { embeddings_api_key: 'x' }, { account_id: 'acct-2' }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(db.rows('ai_configs')[0].api_key).toBe('enc-secret');
    expect(db.rows('api_audit_log')).toHaveLength(0);
  });

  it('validates a new model with the stored key before saving it', async () => {
    expect((await patch({ model: 'gpt-4.1' })).status).toBe(200);
    expect(h.validateCalls).toEqual([{ model: 'gpt-4.1', apiKey: 'plain:enc-secret', provider: 'openai' }]);
    expect(db.rows('ai_configs')[0].model).toBe('gpt-4.1');
  });

  it('keeps the old model when the provider rejects the new one', async () => {
    h.validateError = { message: 'model not found', code: 'invalid_key', status: 400 };
    const res = await patch({ model: 'gpt-nope' });
    expect(res.status).toBe(400);
    expect(db.rows('ai_configs')[0].model).toBe('gpt-4o');
  });

  it('validates the handoff settings like the dashboard', async () => {
    expect((await patch({ handoff_agent_id: STRANGER })).status).toBe(400); // other account's member
    expect((await patch({ timezone: 'Mars/Base' })).status).toBe(400);
    const hours = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map((d) => [d, { open: d !== 'sun', start: '09:00', end: '18:00' }]));
    expect((await patch({ hours: { ...hours, tue: { open: true, start: '18:00', end: '09:00' } } })).status).toBe(400);
    expect((await patch({ open_message: 'x'.repeat(1001) })).status).toBe(400);
    expect(db.rows('ai_configs')[0].handoff_timezone).toBe('Asia/Kuala_Lumpur');

    const ok = await patch({ handoff_agent_id: AGENT, timezone: 'Asia/Singapore', hours, message_enabled: true, open_message: 'Hi', closed_message: 'Back {{next_open_day}}', cap_message: 'Passing you on' });
    expect(ok.status).toBe(200);
    expect(db.rows('ai_configs')[0]).toMatchObject({ handoff_agent_id: AGENT, handoff_timezone: 'Asia/Singapore', handoff_message_enabled: true, handoff_cap_message: 'Passing you on' });
    const body = (await ok.json()).data;
    expect(body).toMatchObject({ timezone: 'Asia/Singapore', message_enabled: true, cap_message: 'Passing you on' });
  });

  it('validates plain fields', async () => {
    for (const body of [{ auto_reply_max_per_conversation: 0 }, { auto_reply_max_per_conversation: 21 }, { auto_reply_max_per_conversation: 2.5 }, { is_active: 'yes' }, { system_prompt: 'x'.repeat(20_001) }, { model: '' }, {}]) {
      expect((await patch(body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it('answers 409 when no provider is set up', async () => {
    db.tables.ai_configs = [];
    expect((await patch({ is_active: true })).status).toBe(409);
  });

  it('needs ai:write', async () => {
    h.scopes = ['ai:read'];
    expect((await patch({ is_active: false })).status).toBe(403);
    expect(db.rows('ai_configs')[0].is_active).toBe(true);
  });
});
