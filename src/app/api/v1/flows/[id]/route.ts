// ============================================================
// GET    /api/v1/flows/{id} — flow with its nodes                 (flows:read)
// PUT    /api/v1/flows/{id} — edit the flow and/or replace nodes  (flows:write)
// PATCH  /api/v1/flows/{id} — same as PUT
// DELETE /api/v1/flows/{id} — delete it and its runs              (flows:write)
//
// PUT body (all optional): name, description, trigger_type, trigger_config,
// entry_node_id, fallback_policy, nodes: [{ node_key, node_type, config,
// position_x?, position_y? }]. `nodes` REPLACES the whole node list.
// An ACTIVE flow is validated before the save is accepted (422 + issues);
// a draft may be incomplete.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { FLOW_TRIGGER_TYPES, isPlainObject, parseFlowNodes, type FlowNodeInput } from '@/lib/api/v1/flow-inputs';
import { FLOWS } from '@/lib/api/v1/resources';
import { validateFlowForActivation } from '@/lib/flows/validate';
import type { ApiKeyContext } from '@/lib/auth/api-context';

const notFound = () => fail('not_found', 'Flow not found', 404);
const NODE_SELECT = 'id, node_key, node_type, config, position_x, position_y';

async function loadFlow(ctx: ApiKeyContext, id: string) {
  if (!isUuidString(id)) return null;
  const { data } = await ctx.supabase
    .from('flows')
    .select(FLOWS.select)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return (data as unknown as Record<string, unknown> | null) ?? null;
}

async function loadNodes(ctx: ApiKeyContext, flowId: string) {
  const { data } = await ctx.supabase
    .from('flow_nodes')
    .select(NODE_SELECT)
    .eq('flow_id', flowId)
    .order('created_at', { ascending: true });
  return data ?? [];
}

export const GET = handler<{ id: string }>('flows:read', async (ctx, _req, { id }) => {
  const flow = await loadFlow(ctx, id);
  if (!flow) return notFound();
  return ok({ flow, nodes: await loadNodes(ctx, id) });
});

const save = handler<{ id: string }>('flows:write', async (ctx, request, { id }) => {
  const raw = await readBody(request);
  const { nodes: rawNodes, ...rest } = raw;
  const data = parseBody(
    rest,
    {
      name: { type: 'string', min: 1, max: 120 },
      description: { type: 'text', max: 500, nullable: true },
      trigger_type: { type: 'enum', values: FLOW_TRIGGER_TYPES },
      trigger_config: { type: 'json', check: isPlainObject },
      entry_node_id: { type: 'string', max: 64, nullable: true },
      fallback_policy: { type: 'json', check: isPlainObject },
    },
    { partial: true, allowEmpty: true }
  );
  const nodes: FlowNodeInput[] | undefined = rawNodes === undefined ? undefined : parseFlowNodes(rawNodes);
  if (Object.keys(data).length === 0 && nodes === undefined) {
    throw badRequest('Nothing to update: send at least one field or nodes');
  }

  const flow = await loadFlow(ctx, id);
  if (!flow) return notFound();

  // An active flow must stay valid: check the merged result first.
  if (flow.status === 'active') {
    const current = nodes ?? ((await loadNodes(ctx, id)) as unknown as FlowNodeInput[]);
    const issues = validateFlowForActivation(
      {
        name: (data.name as string | undefined) ?? (flow.name as string),
        trigger_type: ((data.trigger_type as string | undefined) ?? flow.trigger_type) as (typeof FLOW_TRIGGER_TYPES)[number],
        trigger_config: ((data.trigger_config as Record<string, unknown> | undefined) ?? flow.trigger_config ?? {}) as Record<string, unknown>,
        entry_node_id: 'entry_node_id' in data ? (data.entry_node_id as string | null) : (flow.entry_node_id as string | null),
      },
      current.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config }))
    );
    if (issues.some((i) => i.severity === 'error')) {
      return Response.json(
        { error: { code: 'validation_failed', message: 'This flow is active, so the change would leave it invalid. Set it to draft first, or fix the issues.', issues } },
        { status: 422 }
      );
    }
  }

  if (nodes !== undefined) {
    const { error } = await ctx.supabase.rpc('replace_flow_nodes_for_account', {
      p_account_id: ctx.accountId,
      p_flow_id: id,
      p_nodes: nodes,
    });
    if (error) {
      console.error('[api/v1/flows] replace nodes error:', error);
      return fail('internal', 'Failed to save flow nodes', 500);
    }
  }

  const { error: updErr } = await ctx.supabase
    .from('flows')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (updErr) {
    console.error('[api/v1/flows] update error:', updErr);
    return fail('internal', 'Failed to update flow', 500);
  }

  await recordAudit(ctx, {
    action: 'flow.update',
    resourceType: 'flow',
    resourceId: id,
    fields: [...Object.keys(data), ...(nodes !== undefined ? ['nodes'] : [])],
    detail: nodes !== undefined ? { node_count: nodes.length } : undefined,
  });
  return ok({ flow: await loadFlow(ctx, id), nodes: await loadNodes(ctx, id) });
});

export const PUT = save;
export const PATCH = save;

export const DELETE = handler<{ id: string }>('flows:write', async (ctx, _req, { id }) => {
  const flow = await loadFlow(ctx, id);
  if (!flow) return notFound();
  const { error } = await ctx.supabase.from('flows').delete().eq('id', id).eq('account_id', ctx.accountId);
  if (error) return fail('internal', 'Failed to delete flow', 500);
  await recordAudit(ctx, { action: 'flow.delete', resourceType: 'flow', resourceId: id });
  return ok({ id, deleted: true });
});
