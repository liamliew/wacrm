// POST /api/v1/flows/{id}/validate (flows:read)
// Dry run of the activation check: returns the issues (errors block activation, warnings do not).
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString } from '@/lib/api/v1/input';
import { validateFlowForActivation } from '@/lib/flows/validate';

type FlowFields = Parameters<typeof validateFlowForActivation>[0];
type NodeFields = Parameters<typeof validateFlowForActivation>[1];

export const POST = handler<{ id: string }>('flows:read', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return fail('not_found', 'Flow not found', 404);
  const { data: flow } = await ctx.supabase
    .from('flows')
    .select('name, trigger_type, trigger_config, entry_node_id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!flow) return fail('not_found', 'Flow not found', 404);
  const { data: nodes } = await ctx.supabase.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', id);
  const issues = validateFlowForActivation(flow as unknown as FlowFields, (nodes ?? []) as unknown as NodeFields);
  return ok({ can_activate: !issues.some((i) => i.severity === 'error'), issues });
});
