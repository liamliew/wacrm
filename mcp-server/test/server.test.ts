import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type Config } from '../src/config';
import { WacrmClient } from '../src/client';
import { registerTools } from '../src/tools/index';
import { INSTRUCTIONS } from '../src/instructions';

// ---------------------------------------------------------------
// A stand-in for the wacrm API (global fetch) and a real MCP client
// talking to the real server over an in-memory transport, so these
// tests see exactly what an assistant would: the tool list, the
// annotations, and what each call turns into on the wire.
// ---------------------------------------------------------------

interface Call { method: string; path: string; query: Record<string, string>; body: unknown; auth: string | null }
let calls: Call[] = [];
let responder: (call: Call) => { status?: number; body: unknown } = () => ({ body: { data: { ok: true } } });

beforeEach(() => {
  calls = [];
  responder = () => ({ body: { data: { ok: true } } });
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname.replace(/^\/api\/v1/, ''),
      query: Object.fromEntries(u.searchParams.entries()),
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: (init.headers as Record<string, string>).Authorization ?? null,
    };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

const BASE: Config = {
  baseUrl: 'https://crm.test', apiKey: 'wacrm_live_test',
  enableWrites: false, enableAiAdmin: false, enableAutomations: false, enableDeletes: false, enableBroadcasts: false,
};
const FULL: Config = { ...BASE, enableWrites: true, enableAiAdmin: true, enableAutomations: true, enableDeletes: true, enableBroadcasts: true };

async function connect(config: Config) {
  const server = new McpServer({ name: 'test', version: '0' }, { instructions: INSTRUCTIONS });
  const registered = registerTools(server, new WacrmClient(config), config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const listed = (await client.listTools()).tools;
  return { client, registered, tools: listed, names: new Set(listed.map((t) => t.name)) };
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe('config', () => {
  const env = (e: Record<string, string>) => {
    const old = { ...process.env };
    process.env = { ...old, WACRM_BASE_URL: 'https://crm.test/', WACRM_API_KEY: 'k', ...e };
    try { return loadConfig(); } finally { process.env = old; }
  };
  it('is read-only by default', () => {
    expect(env({})).toMatchObject({ baseUrl: 'https://crm.test', enableWrites: false, enableAiAdmin: false, enableAutomations: false, enableDeletes: false, enableBroadcasts: false });
  });
  it('WACRM_ENABLE_ALL turns everything on', () => {
    expect(env({ WACRM_ENABLE_ALL: 'true' })).toMatchObject({ enableWrites: true, enableAiAdmin: true, enableAutomations: true, enableDeletes: true, enableBroadcasts: true });
  });
  it('refuses any group without writes', () => {
    for (const flag of ['WACRM_ENABLE_AI_ADMIN', 'WACRM_ENABLE_AUTOMATIONS', 'WACRM_ENABLE_DELETES', 'WACRM_ENABLE_BROADCASTS']) {
      expect(() => env({ [flag]: '1' }), flag).toThrow(/requires WACRM_ENABLE_WRITES/);
    }
    expect(env({ WACRM_ENABLE_WRITES: '1', WACRM_ENABLE_AI_ADMIN: 'yes' }).enableAiAdmin).toBe(true);
  });
  it('requires the URL and key', () => {
    const old = { ...process.env };
    delete process.env.WACRM_BASE_URL; delete process.env.WACRM_API_KEY;
    try { expect(() => loadConfig()).toThrow(/WACRM_BASE_URL, WACRM_API_KEY/); } finally { process.env = old; }
  });
});

describe('which tools exist', () => {
  it('read-only: only read tools, all marked read-only', async () => {
    const { tools, registered } = await connect(BASE);
    expect(registered.groups).toEqual(['read']);
    expect(tools.length).toBeGreaterThan(30);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    for (const forbidden of ['send_message', 'update_ai_agent', 'create_flow', 'delete_contact', 'send_broadcast']) {
      expect(tools.map((t) => t.name)).not.toContain(forbidden);
    }
  });

  it('writes alone do not expose AI admin, automations or deletes', async () => {
    const { names } = await connect({ ...BASE, enableWrites: true });
    expect(names.has('update_conversation')).toBe(true);
    expect(names.has('create_deal')).toBe(true);
    for (const n of ['update_ai_agent', 'create_knowledge_document', 'create_flow', 'create_automation', 'delete_tag', 'send_broadcast']) {
      expect(names.has(n), n).toBe(false);
    }
  });

  it('each group adds exactly its own tools', async () => {
    const base = (await connect({ ...BASE, enableWrites: true })).names;
    const ai = (await connect({ ...BASE, enableWrites: true, enableAiAdmin: true })).names;
    const auto = (await connect({ ...BASE, enableWrites: true, enableAutomations: true })).names;
    expect([...ai].filter((n) => !base.has(n)).sort()).toEqual(['create_knowledge_document', 'reindex_knowledge_base', 'update_ai_agent', 'update_knowledge_document']);
    expect([...auto].filter((n) => !base.has(n)).sort()).toEqual(['create_automation', 'create_flow', 'duplicate_automation', 'set_flow_status', 'update_automation', 'update_flow']);
  });

  it('delete tools follow the groups they delete from', async () => {
    const plain = (await connect({ ...BASE, enableWrites: true, enableDeletes: true })).names;
    expect(plain.has('delete_tag')).toBe(true);
    expect(plain.has('delete_knowledge_document')).toBe(false);
    expect(plain.has('delete_flow')).toBe(false);
    const withAi = (await connect({ ...BASE, enableWrites: true, enableDeletes: true, enableAiAdmin: true })).names;
    expect(withAi.has('delete_knowledge_document')).toBe(true);
    const withAuto = (await connect({ ...BASE, enableWrites: true, enableDeletes: true, enableAutomations: true })).names;
    expect(withAuto.has('delete_flow') && withAuto.has('delete_automation')).toBe(true);
  });

  it('full control: unique names, every tool described, annotated and schema\'d', async () => {
    const { tools, registered } = await connect(FULL);
    expect(registered.groups).toEqual(['read', 'write', 'ai-admin', 'automations', 'deletes', 'broadcast']);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(registered.tools.sort()).toEqual(tools.map((t) => t.name).sort());
    expect(tools.length).toBeGreaterThan(70);
    for (const t of tools) {
      expect(t.description?.length ?? 0, `${t.name} description`).toBeGreaterThan(8);
      expect(t.annotations, t.name).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('every delete is destructive and requires confirm; reads never are', async () => {
    const { tools } = await connect(FULL);
    for (const t of tools.filter((x) => x.name.startsWith('delete_'))) {
      expect(t.annotations?.destructiveHint, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(false);
      expect(t.inputSchema.required, t.name).toContain('confirm');
    }
    for (const t of tools.filter((x) => x.annotations?.readOnlyHint)) expect(t.annotations?.destructiveHint, t.name).not.toBe(true);
  });
});

describe('what calls turn into', () => {
  it('sends the bearer key and maps reads to GETs with clean queries', async () => {
    const { client } = await connect(BASE);
    responder = () => ({ body: { data: [], meta: { next_cursor: 'abc' } } });
    const res = await client.callTool({ name: 'list_deals', arguments: { pipeline_id: 'p1', status: 'open', limit: 5 } });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/deals', query: { pipeline_id: 'p1', status: 'open', limit: '5' }, auth: 'Bearer wacrm_live_test' });
    expect(Object.keys(calls[0].query)).not.toContain('cursor');
    expect(JSON.parse(text(res))).toEqual({ data: [], next_cursor: 'abc' });
  });

  it('encodes ids into paths', async () => {
    const { client } = await connect(BASE);
    await client.callTool({ name: 'get_knowledge_document', arguments: { id: 'a/b c' } });
    expect(calls[0].path).toBe('/ai/knowledge/a%2Fb%20c');
  });

  it('maps the AI agent tools onto the right endpoints', async () => {
    const { client } = await connect(FULL);
    await client.callTool({ name: 'get_ai_agent', arguments: {} });
    await client.callTool({ name: 'update_ai_agent', arguments: { system_prompt: 'Be brief', auto_reply_max_per_conversation: 4, cap_message: 'Passing you on' } });
    await client.callTool({ name: 'test_ai_agent', arguments: { messages: [{ role: 'user', content: 'hi' }], system_prompt: 'candidate' } });
    await client.callTool({ name: 'preview_handoff_message', arguments: { time: '2026-10-26T20:00', reason: 'cap' } });
    await client.callTool({ name: 'create_knowledge_document', arguments: { title: 'Returns', content: '30 days' } });
    await client.callTool({ name: 'update_knowledge_document', arguments: { id: 'd1', content: '14 days' } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /ai/config', 'PATCH /ai/config', 'POST /ai/playground', 'POST /ai/handoff/preview', 'POST /ai/knowledge', 'PATCH /ai/knowledge/d1',
    ]);
    expect(calls[1].body).toEqual({ system_prompt: 'Be brief', auto_reply_max_per_conversation: 4, cap_message: 'Passing you on' });
    expect(calls[2].body).toMatchObject({ system_prompt: 'candidate' });
    expect(calls[5].body).toEqual({ content: '14 days' }); // the id is in the path, not the body
  });

  it('maps inbox and settings tools', async () => {
    const { client } = await connect(FULL);
    await client.callTool({ name: 'update_conversation', arguments: { id: 'c1', status: 'closed', ai_paused: true } });
    await client.callTool({ name: 'set_contact_custom_fields', arguments: { contact_id: 'ct', values: { f1: 'Gold', f2: null } } });
    await client.callTool({ name: 'add_pipeline_stage', arguments: { pipeline_id: 'p', name: 'Review' } });
    await client.callTool({ name: 'update_deal', arguments: { id: 'd', stage_id: 's2', status: 'won' } });
    await client.callTool({ name: 'update_flow', arguments: { id: 'f', nodes: [{ node_key: 'a', node_type: 'start', config: {} }] } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /conversations/c1', 'PUT /contacts/ct/custom-fields', 'POST /pipelines/p/stages', 'PATCH /deals/d', 'PUT /flows/f',
    ]);
    expect(calls[0].body).toEqual({ status: 'closed', ai_paused: true });
    expect(calls[1].body).toEqual({ values: { f1: 'Gold', f2: null } });
  });

  it('turns API errors into readable tool errors, with validation issues', async () => {
    const { client } = await connect(FULL);
    responder = () => ({ status: 403, body: { error: { code: 'forbidden', message: "This API key is missing the 'ai:write' scope" } } });
    const denied = await client.callTool({ name: 'update_ai_agent', arguments: { system_prompt: 'x' } });
    expect(isError(denied)).toBe(true);
    expect(text(denied)).toContain('[forbidden]');
    expect(text(denied)).toContain('ai:write');

    responder = () => ({ status: 422, body: { error: { code: 'validation_failed', message: 'cannot activate', issues: [{ severity: 'error', message: 'No start node' }] } } });
    const bad = await client.callTool({ name: 'set_flow_status', arguments: { id: 'f', status: 'active', confirm: true } });
    expect(isError(bad)).toBe(true);
    expect(text(bad)).toContain('No start node');
  });

  it('reports an unreachable server instead of crashing', async () => {
    const { client } = await connect(BASE);
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    const res = await client.callTool({ name: 'list_tags', arguments: {} });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain('Could not reach wacrm');
  });
});

describe('confirmation gates', () => {
  it('deletes do nothing without confirm=true', async () => {
    const { client } = await connect(FULL);
    for (const [name, args] of [['delete_contact', { id: 'c' }], ['delete_tag', { id: 't' }], ['delete_flow', { id: 'f' }], ['delete_contact_note', { contact_id: 'c', note_id: 'n' }]] as const) {
      const no = await client.callTool({ name, arguments: { ...args } }).catch(() => null);
      // Missing confirm is rejected by the schema (thrown) or by the gate (error result).
      if (no) expect(isError(no), name).toBe(true);
      const no2 = await client.callTool({ name, arguments: { ...args, confirm: false } }).catch(() => null);
      if (no2) { expect(isError(no2), name).toBe(true); expect(text(no2)).toContain('confirm=true'); }
    }
    expect(calls).toHaveLength(0);
    const yes = await client.callTool({ name: 'delete_contact_note', arguments: { contact_id: 'c', note_id: 'n', confirm: true } });
    expect(isError(yes)).toBe(false);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/contacts/c/notes/n' });
  });

  it('never forwards the confirm flag to the API', async () => {
    const { client } = await connect(FULL);
    await client.callTool({ name: 'delete_deal', arguments: { id: 'd', confirm: true } });
    await client.callTool({ name: 'submit_template', arguments: { name: 't', category: 'Utility', language: 'en_US', body_text: 'Hi', confirm: true } });
    expect(JSON.stringify(calls)).not.toContain('confirm');
  });

  it('turning the AI on, activating flows and automations, and submitting templates need confirm; quieter edits do not', async () => {
    const { client } = await connect(FULL);
    const needs = [
      ['update_ai_agent', { is_active: true }], ['update_ai_agent', { auto_reply_enabled: true }],
      ['set_flow_status', { id: 'f', status: 'active' }], ['create_automation', { name: 'a', trigger_type: 'tag_added', is_active: true }],
      ['update_automation', { id: 'a', is_active: true }], ['submit_template', { name: 't', category: 'Utility', language: 'en_US', body_text: 'Hi' }],
    ] as const;
    for (const [name, args] of needs) expect(isError(await client.callTool({ name, arguments: { ...args } })), JSON.stringify([name, args])).toBe(true);
    expect(calls).toHaveLength(0);

    for (const [name, args] of [
      ['update_ai_agent', { system_prompt: 'x' }], ['update_ai_agent', { is_active: false }], ['update_ai_agent', { auto_reply_enabled: false }],
      ['set_flow_status', { id: 'f', status: 'draft' }], ['create_automation', { name: 'a', trigger_type: 'tag_added' }], ['update_automation', { id: 'a', is_active: false }],
    ] as const) {
      expect(isError(await client.callTool({ name, arguments: { ...args } })), JSON.stringify([name, args])).toBe(false);
    }
    expect(calls).toHaveLength(6);
  });

  it('rejects arguments that do not match the schema before calling the API', async () => {
    const { client } = await connect(FULL);
    const res = await client.callTool({ name: 'update_ai_agent', arguments: { auto_reply_max_per_conversation: 99 } }).catch((e) => e);
    // The SDK reports schema violations either as an error result or an exception; either way nothing was sent.
    expect(calls).toHaveLength(0);
    expect(res).toBeDefined();
  });
});

describe('what the model is told', () => {
  it('server instructions state the trust boundary', async () => {
    const { client } = await connect(BASE);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('UNTRUSTED');
    expect(instructions).toContain('get_audit_log');
  });
  it('AI admin tools say whom the change affects and point to the dry run', async () => {
    const { tools } = await connect(FULL);
    const t = Object.fromEntries(tools.map((x) => [x.name, x.description ?? '']));
    expect(t.update_ai_agent).toContain('REAL customers');
    expect(t.update_ai_agent).toContain('test_ai_agent');
    expect(t.create_automation).toContain('Webhook steps can only be made in the dashboard');
    expect(t.test_ai_agent).toContain('WITHOUT sending');
  });
  it('does not expose secrets-handling tools', async () => {
    const { names } = await connect(FULL);
    for (const n of names) expect(n).not.toMatch(/api_key|token|secret|webhook|invite|password|(create|update|delete|remove)_member|set_.*role/);
  });
});
