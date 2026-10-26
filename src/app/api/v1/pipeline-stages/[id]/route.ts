// ============================================================
// GET/PATCH/DELETE /api/v1/pipeline-stages/{id}
// Stages have no account column of their own; ownership is checked
// through the pipeline they belong to. DELETE is refused (409) while
// deals still sit in the stage — move or delete them first.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { STAGE_SELECT, pipelineInAccount } from '@/lib/api/v1/pipelines';
import { STAGE_SCHEMA } from '@/lib/api/v1/stage-schema';
import type { ApiKeyContext } from '@/lib/auth/api-context';

async function loadStage(ctx: ApiKeyContext, id: string) {
  if (!isUuidString(id)) return null;
  const { data } = await ctx.supabase
    .from('pipeline_stages')
    .select(STAGE_SELECT)
    .eq('id', id)
    .maybeSingle();
  const stage = data as { id: string; pipeline_id: string } | null;
  if (!stage || !(await pipelineInAccount(ctx, stage.pipeline_id))) return null;
  return stage;
}

export const GET = handler<{ id: string }>('pipelines:read', async (ctx, _request, { id }) => {
  const stage = await loadStage(ctx, id);
  return stage ? ok(stage) : fail('not_found', 'Stage not found', 404);
});

export const PATCH = handler<{ id: string }>('pipelines:write', async (ctx, request, { id }) => {
  const data = parseBody(await readBody(request), STAGE_SCHEMA, { partial: true });
  const stage = await loadStage(ctx, id);
  if (!stage) return fail('not_found', 'Stage not found', 404);

  const { data: updated, error } = await ctx.supabase
    .from('pipeline_stages')
    .update(data)
    .eq('id', id)
    .eq('pipeline_id', stage.pipeline_id)
    .select(STAGE_SELECT)
    .maybeSingle();
  if (error || !updated) return fail('internal', 'Failed to update stage', 500);
  await recordAudit(ctx, {
    action: 'pipeline_stage.update',
    resourceType: 'pipeline_stage',
    resourceId: id,
    fields: Object.keys(data),
  });
  return ok(updated);
});

export const DELETE = handler<{ id: string }>('pipelines:write', async (ctx, _request, { id }) => {
  const stage = await loadStage(ctx, id);
  if (!stage) return fail('not_found', 'Stage not found', 404);

  const { data: deals } = await ctx.supabase
    .from('deals')
    .select('id')
    .eq('stage_id', id)
    .eq('account_id', ctx.accountId)
    .limit(1);
  if ((deals ?? []).length > 0) {
    return fail('conflict', 'Move or delete the deals in this stage first', 409);
  }
  const { error } = await ctx.supabase
    .from('pipeline_stages')
    .delete()
    .eq('id', id)
    .eq('pipeline_id', stage.pipeline_id);
  if (error) return fail('internal', 'Failed to delete stage', 500);
  await recordAudit(ctx, { action: 'pipeline_stage.delete', resourceType: 'pipeline_stage', resourceId: id });
  return ok({ id, deleted: true });
});
