// GET /api/v1/flows/{id}/runs (flows:read) — the 50 most recent runs, newest first.
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString } from '@/lib/api/v1/input';

export const GET = handler<{ id: string }>('flows:read', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return fail('not_found', 'Flow not found', 404);
  const { data: flow } = await ctx.supabase.from('flows').select('id').eq('id', id).eq('account_id', ctx.accountId).maybeSingle();
  if (!flow) return fail('not_found', 'Flow not found', 404);
  const { data, error } = await ctx.supabase
    .from('flow_runs')
    .select('id, contact_id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, reprompt_count')
    .eq('flow_id', id)
    .eq('account_id', ctx.accountId)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) return fail('internal', 'Failed to list flow runs', 500);
  return ok(data ?? []);
});
