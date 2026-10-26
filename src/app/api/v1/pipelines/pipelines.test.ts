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

import { GET as listPipelines, POST as createPipeline } from './route';
import * as pipelineItem from './[id]/route';
import { POST as addStage } from './[id]/stages/route';
import * as stageItem from '../pipeline-stages/[id]/route';
import { collection, item } from '@/lib/api/v1/crud';
import { DEALS } from '@/lib/api/v1/resources';

const deals = collection(DEALS);
const deal = item(DEALS);

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const S1 = 'a1111111-1111-4111-8111-111111111111';
const S1b = 'a1111111-1111-4111-8111-111111111112';
const S2 = 'a2222222-2222-4222-8222-222222222222';
const CT1 = 'c1111111-1111-4111-8111-111111111111';
const CT2 = 'c2222222-2222-4222-8222-222222222222';
const D1 = 'd1111111-1111-4111-8111-111111111111';
const D2 = 'd2222222-2222-4222-8222-222222222222';
const U1 = 'e1111111-1111-4111-8111-111111111111';
const U2 = 'e2222222-2222-4222-8222-222222222222';
let db: FakeDb;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = 'https://x.test/api/v1/x') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  db = new FakeDb();
  db.seed('accounts', [{ id: 'acct-1', owner_user_id: 'owner-1' }]);
  db.seed('pipelines', [
    { id: P1, account_id: 'acct-1', name: 'Sales', created_at: '2026-01-02' },
    { id: P2, account_id: 'acct-2', name: 'Theirs', created_at: '2026-01-01' },
  ]);
  db.seed('pipeline_stages', [
    { id: S1, pipeline_id: P1, name: 'New', position: 0, color: '#3b82f6', created_at: 'a' },
    { id: S1b, pipeline_id: P1, name: 'Won', position: 1, color: '#10b981', created_at: 'b' },
    { id: S2, pipeline_id: P2, name: 'Their stage', position: 0, color: '#000000', created_at: 'c' },
  ]);
  db.seed('contacts', [{ id: CT1, account_id: 'acct-1' }, { id: CT2, account_id: 'acct-2' }]);
  db.seed('profiles', [{ id: U1, user_id: 'u1', account_id: 'acct-1' }, { id: U2, user_id: 'u2', account_id: 'acct-2' }]);
  db.seed('deals', [
    { id: D1, account_id: 'acct-1', pipeline_id: P1, stage_id: S1, contact_id: CT1, title: 'Mine', value: 10, status: 'open', created_at: '2026-01-02' },
    { id: D2, account_id: 'acct-2', pipeline_id: P2, stage_id: S2, contact_id: CT2, title: 'Theirs', value: 99, status: 'open', created_at: '2026-01-01' },
  ]);
  h.db = db;
  h.scopes = ['pipelines:read', 'pipelines:write'];
});

describe('pipelines', () => {
  it('lists this account\'s pipelines with their stages in order', async () => {
    const body = await (await listPipelines(req('GET'))).json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Sales');
    expect(body.data[0].stages.map((s: { name: string }) => s.name)).toEqual(['New', 'Won']);
    expect(JSON.stringify(body)).not.toContain('Their stage');
  });

  it('creates a pipeline with stages, attributed to the owner, and audits', async () => {
    const res = await createPipeline(req('POST', { name: 'Support', stages: ['Open', { name: 'Done', color: '#10b981' }] }));
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created.stages.map((s: { name: string; position: number }) => [s.name, s.position])).toEqual([['Open', 0], ['Done', 1]]);
    expect(db.rows('pipelines').find((p) => p.name === 'Support')).toMatchObject({ account_id: 'acct-1', user_id: 'owner-1' });
    expect(db.rows('api_audit_log')[0]).toMatchObject({ action: 'pipeline.create', summary: { fields: ['name'], stages: 2 } });
  });

  it('validates pipeline input', async () => {
    for (const body of [{}, { name: '' }, { name: 'x', stages: 'nope' }, { name: 'x', stages: [{ name: '' }] }, { name: 'x', stages: [{ name: 'a', color: 'red' }] }, { name: 'x', user_id: 'u' }]) {
      expect((await createPipeline(req('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('reads one with stages, only its own', async () => {
    const res = await pipelineItem.GET(req('GET'), ctx(P1));
    expect((await res.json()).data.stages).toHaveLength(2);
    expect((await pipelineItem.GET(req('GET'), ctx(P2))).status).toBe(404);
  });

  it('deletes only its own', async () => {
    expect((await pipelineItem.DELETE!(req('DELETE'), ctx(P2))).status).toBe(404);
    expect(db.rows('pipelines')).toHaveLength(2);
    expect((await pipelineItem.DELETE!(req('DELETE'), ctx(P1))).status).toBe(200);
  });
});

describe('stages', () => {
  it('adds a stage at the end of an own pipeline, not another account\'s', async () => {
    const res = await addStage(req('POST', { name: 'Review' }), ctx(P1));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ pipeline_id: P1, name: 'Review', position: 2 });
    expect((await addStage(req('POST', { name: 'Hack' }), ctx(P2))).status).toBe(404);
    expect(db.rows('pipeline_stages').filter((s) => s.pipeline_id === P2)).toHaveLength(1);
  });

  it('edits and deletes only stages of own pipelines', async () => {
    expect((await stageItem.PATCH(req('PATCH', { name: 'Renamed' }), ctx(S1))).status).toBe(200);
    expect(db.rows('pipeline_stages').find((s) => s.id === S1)!.name).toBe('Renamed');
    expect((await stageItem.PATCH(req('PATCH', { name: 'Pwned' }), ctx(S2))).status).toBe(404);
    expect(db.rows('pipeline_stages').find((s) => s.id === S2)!.name).toBe('Their stage');
    expect((await stageItem.DELETE!(req('DELETE'), ctx(S2))).status).toBe(404);
    expect((await stageItem.DELETE!(req('DELETE'), ctx(S1b))).status).toBe(200);
  });

  it('refuses to delete a stage that still holds deals', async () => {
    const res = await stageItem.DELETE!(req('DELETE'), ctx(S1));
    expect(res.status).toBe(409);
    expect(db.rows('pipeline_stages').some((s) => s.id === S1)).toBe(true);
  });

  it('validates stage input', async () => {
    expect((await stageItem.PATCH(req('PATCH', {}), ctx(S1))).status).toBe(400);
    expect((await stageItem.PATCH(req('PATCH', { position: -1 }), ctx(S1))).status).toBe(400);
    expect((await stageItem.PATCH(req('PATCH', { color: 'blue' }), ctx(S1))).status).toBe(400);
  });
});

describe('deals', () => {
  const base = { title: 'New deal', pipeline_id: P1, stage_id: S1, contact_id: CT1 };

  it('creates a deal, open by default, and lists only the account\'s', async () => {
    const res = await deals.POST!(req('POST', { ...base, value: 250, currency: 'MYR', assigned_to: U1 }));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ title: 'New deal', status: 'open', value: 250, assigned_to: U1 });
    expect(db.rows('deals').find((d) => d.title === 'New deal')).toMatchObject({ account_id: 'acct-1', user_id: 'owner-1' });
    const list = await (await deals.GET(req('GET'))).json();
    expect(list.data.map((d: { title: string }) => d.title).sort()).toEqual(['Mine', 'New deal']);
  });

  it('refuses references to another account\'s pipeline, contact, member, or a mismatched stage', async () => {
    expect((await deals.POST!(req('POST', { ...base, pipeline_id: P2, stage_id: S2 }))).status).toBe(400);
    expect((await deals.POST!(req('POST', { ...base, contact_id: CT2 }))).status).toBe(400);
    expect((await deals.POST!(req('POST', { ...base, assigned_to: U2 }))).status).toBe(400);
    expect((await deals.POST!(req('POST', { ...base, stage_id: S2 }))).status).toBe(400);
    expect(db.rows('deals')).toHaveLength(2);
  });

  it('moves a deal between stages of its pipeline and marks it won', async () => {
    expect((await deal.PATCH(req('PATCH', { stage_id: S1b }), ctx(D1))).status).toBe(200);
    expect(db.rows('deals').find((d) => d.id === D1)!.stage_id).toBe(S1b);
    expect((await deal.PATCH(req('PATCH', { status: 'won' }), ctx(D1))).status).toBe(200);
    expect(db.rows('deals').find((d) => d.id === D1)!.status).toBe('won');
    expect((await deal.PATCH(req('PATCH', { stage_id: S2 }), ctx(D1))).status).toBe(400);
    expect((await deal.PATCH(req('PATCH', { status: 'maybe' }), ctx(D1))).status).toBe(400);
  });

  it('cannot read, edit or delete another account\'s deal', async () => {
    expect((await deal.GET(req('GET'), ctx(D2))).status).toBe(404);
    expect((await deal.PATCH(req('PATCH', { title: 'x' }), ctx(D2))).status).toBe(404);
    expect((await deal.DELETE!(req('DELETE'), ctx(D2))).status).toBe(404);
    expect(db.rows('deals').find((d) => d.id === D2)!.title).toBe('Theirs');
  });

  it('filters the list and rejects bad filters', async () => {
    const res = await deals.GET(req('GET', undefined, `https://x.test/api/v1/deals?pipeline_id=${P1}&status=open`));
    expect(res.status).toBe(200);
    expect((await deals.GET(req('GET', undefined, 'https://x.test/api/v1/deals?status=nope'))).status).toBe(400);
  });

  it('needs the right scopes', async () => {
    h.scopes = ['pipelines:read'];
    expect((await deals.POST!(req('POST', base))).status).toBe(403);
    expect((await createPipeline(req('POST', { name: 'x' }))).status).toBe(403);
    expect((await addStage(req('POST', { name: 'x' }), ctx(P1))).status).toBe(403);
    h.scopes = ['pipelines:write'];
    expect((await deals.GET(req('GET'))).status).toBe(403);
  });
});
