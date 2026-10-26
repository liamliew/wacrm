// ============================================================
// GET  /api/v1/pipelines — list pipelines with their stages (pipelines:read)
// POST /api/v1/pipelines — create a pipeline, optionally with stages (pipelines:write)
//   body: { name, stages?: [{ name, color? }] }
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, okList, fail } from '@/lib/api/v1/respond';
import { badRequest } from '@/lib/api/v1/respond';
import { parseBody, readBody } from '@/lib/api/v1/input';
import { buildPage, keysetFilter, parseListParams } from '@/lib/api/v1/pagination';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { PIPELINES } from '@/lib/api/v1/resources';
import { STAGE_SELECT, DEFAULT_STAGE_COLORS, parseStages } from '@/lib/api/v1/pipelines';

export const GET = handler('pipelines:read', async (ctx, request) => {
  const { limit, cursor } = parseListParams(request);
  let query = ctx.supabase
    .from('pipelines')
    .select(PIPELINES.select)
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  const kf = keysetFilter(cursor);
  if (kf) query = query.or(kf);

  const { data, error } = await query;
  if (error) {
    console.error('[api/v1/pipelines] list error:', error);
    return fail('internal', 'Failed to list pipelines', 500);
  }
  const { items, nextCursor } = buildPage(
    (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
    limit
  );
  const ids = items.map((p) => p.id);
  const stages = ids.length
    ? ((
        await ctx.supabase
          .from('pipeline_stages')
          .select(STAGE_SELECT)
          .in('pipeline_id', ids)
          .order('position', { ascending: true })
      ).data ?? [])
    : [];
  return okList(
    items.map((p) => ({
      ...p,
      stages: (stages as unknown as Array<{ pipeline_id: string }>).filter(
        (s) => s.pipeline_id === p.id
      ),
    })),
    nextCursor
  );
});

export const POST = handler('pipelines:write', async (ctx, request) => {
  const raw = await readBody(request);
  const { stages: rawStages, ...rest } = raw;
  const data = parseBody(rest, PIPELINES.schema, { partial: false });
  const stages = rawStages === undefined ? [] : parseStages(rawStages);
  if (stages.length > 30) throw badRequest("'stages' can have at most 30 entries");

  const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
  const { data: pipeline, error } = await ctx.supabase
    .from('pipelines')
    .insert({ ...data, account_id: ctx.accountId, user_id: userId })
    .select(PIPELINES.select)
    .single();
  if (error || !pipeline) {
    console.error('[api/v1/pipelines] create error:', error);
    return fail('internal', 'Failed to create pipeline', 500);
  }
  const pipelineId = (pipeline as unknown as { id: string }).id;

  let createdStages: unknown[] = [];
  if (stages.length > 0) {
    const { data: rows, error: stageErr } = await ctx.supabase
      .from('pipeline_stages')
      .insert(
        stages.map((s, i) => ({
          pipeline_id: pipelineId,
          name: s.name,
          color: s.color ?? DEFAULT_STAGE_COLORS[i % DEFAULT_STAGE_COLORS.length],
          position: i,
        }))
      )
      .select(STAGE_SELECT);
    if (stageErr) {
      // Don't leave a pipeline that was meant to have stages sitting empty.
      await ctx.supabase.from('pipelines').delete().eq('id', pipelineId).eq('account_id', ctx.accountId);
      console.error('[api/v1/pipelines] stage create error:', stageErr);
      return fail('internal', 'Failed to create pipeline stages', 500);
    }
    createdStages = (rows ?? []) as unknown[];
  }

  await recordAudit(ctx, {
    action: 'pipeline.create',
    resourceType: 'pipeline',
    resourceId: pipelineId,
    fields: Object.keys(data),
    detail: { stages: stages.length },
  });
  return ok({ ...(pipeline as object), stages: createdStages }, 201);
});
