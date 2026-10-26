// ============================================================
// GET  /api/v1/flows — list flows (?status= ?trigger_type=)   (flows:read)
// POST /api/v1/flows — create a draft flow                    (flows:write)
//   body: { name, description?, trigger_type?, trigger_config? }
//      or { template_slug, name? }   — clone a built-in template
// A new flow is always a DRAFT; activate it with POST /flows/{id}/status.
// ============================================================

import { collection } from '@/lib/api/v1/crud';
import { FLOWS } from '@/lib/api/v1/resources';
import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { FLOW_TRIGGER_TYPES, isPlainObject } from '@/lib/api/v1/flow-inputs';
import { getFlowTemplate } from '@/lib/flows/templates';

export const { GET } = collection(FLOWS);

export const POST = handler('flows:write', async (ctx, request) => {
  const data = parseBody(
    await readBody(request),
    {
      name: { type: 'string', max: 120 },
      description: { type: 'text', max: 500, nullable: true },
      trigger_type: { type: 'enum', values: FLOW_TRIGGER_TYPES },
      trigger_config: { type: 'json', check: isPlainObject },
      template_slug: { type: 'string', max: 80 },
    },
    { partial: false }
  );
  const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

  let row: Record<string, unknown>;
  let nodes: { node_key: string; node_type: string; config: unknown }[] = [];
  if (typeof data.template_slug === 'string') {
    const template = getFlowTemplate(data.template_slug);
    if (!template) throw badRequest(`Unknown template_slug '${data.template_slug}'`);
    row = {
      name: (data.name as string | undefined) || template.name,
      description: template.description,
      trigger_type: template.trigger_type,
      trigger_config: template.trigger_config,
      entry_node_id: template.entry_node_id,
    };
    nodes = template.nodes;
  } else {
    if (!data.name) throw badRequest("'name' is required");
    row = {
      name: data.name,
      description: data.description ?? null,
      trigger_type: data.trigger_type ?? 'keyword',
      trigger_config: data.trigger_config ?? {},
    };
  }

  const { data: flow, error } = await ctx.supabase
    .from('flows')
    .insert({ ...row, status: 'draft', user_id: userId, account_id: ctx.accountId })
    .select(FLOWS.select)
    .single();
  if (error || !flow) {
    console.error('[api/v1/flows] create error:', error);
    return fail('internal', 'Failed to create flow', 500);
  }
  const flowId = (flow as unknown as { id: string }).id;

  if (nodes.length > 0) {
    const { error: nodesErr } = await ctx.supabase.from('flow_nodes').insert(
      nodes.map((n) => ({ flow_id: flowId, node_key: n.node_key, node_type: n.node_type, config: n.config }))
    );
    if (nodesErr) {
      // Do not leave a half-cloned template sitting as an empty draft.
      await ctx.supabase.from('flows').delete().eq('id', flowId).eq('account_id', ctx.accountId);
      console.error('[api/v1/flows] template nodes error:', nodesErr);
      return fail('internal', 'Failed to create flow nodes', 500);
    }
  }

  await recordAudit(ctx, {
    action: 'flow.create',
    resourceType: 'flow',
    resourceId: flowId,
    fields: Object.keys(data),
    detail: data.template_slug ? { template_slug: data.template_slug } : undefined,
  });
  return ok(flow, 201);
});
