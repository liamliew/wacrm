// ============================================================
// GET/PATCH/DELETE /api/v1/pipelines/{id}
// GET includes the pipeline's stages. DELETE also removes its stages
// and deals (the database cascades), so the MCP server asks for
// confirmation before calling it.
// ============================================================

import { item } from '@/lib/api/v1/crud';
import { PIPELINES } from '@/lib/api/v1/resources';
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { STAGE_SELECT } from '@/lib/api/v1/pipelines';

const base = item(PIPELINES);

export const GET = handler<{ id: string }>('pipelines:read', async (ctx, request, params) => {
  const res = await base.GET(request, { params: Promise.resolve(params) });
  if (res.status !== 200) return res;
  const { data: pipeline } = (await res.json()) as { data: { id: string } };
  const { data: stages, error } = await ctx.supabase
    .from('pipeline_stages')
    .select(STAGE_SELECT)
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true });
  if (error) return fail('internal', 'Failed to read pipeline stages', 500);
  return ok({ ...pipeline, stages: stages ?? [] });
});

export const { PATCH, DELETE } = base;
