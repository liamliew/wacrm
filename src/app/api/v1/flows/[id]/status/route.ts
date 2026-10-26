// ============================================================
// POST /api/v1/flows/{id}/status  (flows:write)   body: { status: "draft"|"active"|"archived" }
// Activating runs the full validator and is refused (422 + issues) on any
// error. Moving to draft or archived cancels the flow's in-progress runs.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { FLOW_STATUSES } from '@/lib/api/v1/flow-inputs';
import { validateFlowForActivation } from '@/lib/flows/validate';
import { FLOWS } from '@/lib/api/v1/resources';

type FlowFields = Parameters<typeof validateFlowForActivation>[0];
type NodeFields = Parameters<typeof validateFlowForActivation>[1];

export const POST = handler<{ id: string }>('flows:write', async (ctx, request, { id }) => {
  const { status } = parseBody(await readBody(request), { status: { type: 'enum', values: FLOW_STATUSES, required: true } }, { partial: false }) as { status: string };
  if (!isUuidString(id)) return fail('not_found', 'Flow not found', 404);

  const { data: flow } = await ctx.supabase
    .from('flows')
    .select('name, trigger_type, trigger_config, entry_node_id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!flow) return fail('not_found', 'Flow not found', 404);

  if (status === 'active') {
    const { data: nodes } = await ctx.supabase.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', id);
    const issues = validateFlowForActivation(flow as unknown as FlowFields, (nodes ?? []) as unknown as NodeFields);
    if (issues.some((i) => i.severity === 'error')) {
      return Response.json(
        { error: { code: 'validation_failed', message: 'This flow cannot be activated yet. Fix the issues and try again.', issues } },
        { status: 422 }
      );
    }
  }

  const { data: updated, error } = await ctx.supabase
    .from('flows')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(FLOWS.select)
    .maybeSingle();
  if (error || !updated) return fail('internal', 'Failed to change flow status', 500);

  if (status !== 'active') {
    const { error: runsErr } = await ctx.supabase
      .from('flow_runs')
      .update({ status: 'cancelled', ended_at: new Date().toISOString(), end_reason: `flow_${status}` })
      .eq('flow_id', id)
      .eq('account_id', ctx.accountId)
      .eq('status', 'active');
    if (runsErr) console.error('[api/v1/flows] cancel active runs failed:', runsErr.message);
  }

  await recordAudit(ctx, { action: 'flow.status', resourceType: 'flow', resourceId: id, detail: { status } });
  return ok(updated);
});
