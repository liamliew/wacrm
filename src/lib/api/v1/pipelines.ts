// Shared bits for the pipeline + stage routes.

import { badRequest } from '@/lib/api/v1/respond';
import type { ApiKeyContext } from '@/lib/auth/api-context';

export const STAGE_SELECT = 'id, pipeline_id, name, position, color, created_at';

/** The palette the dashboard cycles through for new stages. */
export const DEFAULT_STAGE_COLORS = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#06b6d4',
];

const HEX = /^#[0-9a-fA-F]{6}$/;

export function parseStages(raw: unknown): { name: string; color?: string }[] {
  if (!Array.isArray(raw)) throw badRequest("'stages' must be an array");
  return raw.map((entry, i) => {
    const e = typeof entry === 'string' ? { name: entry } : (entry as Record<string, unknown>);
    if (!e || typeof e !== 'object') throw badRequest(`stages[${i}] must be a name or { name, color }`);
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name || name.length > 60) throw badRequest(`stages[${i}].name must be 1-60 characters`);
    if (e.color !== undefined && (typeof e.color !== 'string' || !HEX.test(e.color))) {
      throw badRequest(`stages[${i}].color must be a hex color like #3b82f6`);
    }
    return { name, color: e.color as string | undefined };
  });
}

/** True when the pipeline exists in the caller's account. */
export async function pipelineInAccount(ctx: ApiKeyContext, pipelineId: string): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('pipelines')
    .select('id')
    .eq('id', pipelineId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return !!data;
}
