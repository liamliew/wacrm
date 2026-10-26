// ============================================================
// GET  /api/v1/pipelines/{id}/stages — list stages in order (pipelines:read)
// POST /api/v1/pipelines/{id}/stages — add a stage        (pipelines:write)
//   body: { name, color?, position? }   position defaults to the end
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { STAGE_SELECT, DEFAULT_STAGE_COLORS, pipelineInAccount } from '@/lib/api/v1/pipelines';
import { STAGE_SCHEMA } from '@/lib/api/v1/stage-schema';

export const GET = handler<{ id: string }>('pipelines:read', async (ctx, _request, { id }) => {
  if (!isUuidString(id) || !(await pipelineInAccount(ctx, id))) {
    return fail('not_found', 'Pipeline not found', 404);
  }
  const { data, error } = await ctx.supabase
    .from('pipeline_stages')
    .select(STAGE_SELECT)
    .eq('pipeline_id', id)
    .order('position', { ascending: true });
  if (error) return fail('internal', 'Failed to list stages', 500);
  return ok(data ?? []);
});

export const POST = handler<{ id: string }>('pipelines:write', async (ctx, request, { id }) => {
  if (!isUuidString(id) || !(await pipelineInAccount(ctx, id))) {
    return fail('not_found', 'Pipeline not found', 404);
  }
  const data = parseBody(await readBody(request), STAGE_SCHEMA, { partial: false });

  const { data: existing } = await ctx.supabase
    .from('pipeline_stages')
    .select('id, position')
    .eq('pipeline_id', id);
  const count = (existing ?? []).length;
  if (count >= 30) return fail('conflict', 'A pipeline can have at most 30 stages', 409);

  const { data: stage, error } = await ctx.supabase
    .from('pipeline_stages')
    .insert({
      pipeline_id: id,
      name: data.name,
      color: data.color ?? DEFAULT_STAGE_COLORS[count % DEFAULT_STAGE_COLORS.length],
      position: data.position ?? count,
    })
    .select(STAGE_SELECT)
    .single();
  if (error || !stage) {
    console.error('[api/v1/stages] create error:', error);
    return fail('internal', 'Failed to create stage', 500);
  }
  await recordAudit(ctx, {
    action: 'pipeline_stage.create',
    resourceType: 'pipeline_stage',
    resourceId: (stage as { id: string }).id,
    fields: Object.keys(data),
    detail: { pipeline_id: id },
  });
  return ok(stage, 201);
});
