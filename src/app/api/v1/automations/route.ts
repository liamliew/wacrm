// ============================================================
// GET  /api/v1/automations — list (?trigger_type=)             (automations:read)
// POST /api/v1/automations — create                            (automations:write)
//   body: { name, trigger_type, trigger_config?, description?, is_active?, steps? }
//      or { template: "<slug>" }  (see GET /automations/templates)
//
// Drafts (is_active false, the default) may be incomplete. Creating one
// already active is validated first (400 + issues).
// ============================================================

import { collection } from '@/lib/api/v1/crud';
import { AUTOMATIONS } from '@/lib/api/v1/resources';
import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { AUTOMATION_TRIGGER_TYPES, isPlainObject, parseAutomationSteps } from '@/lib/api/v1/flow-inputs';
import { getTemplate } from '@/lib/automations/templates';
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree';
import { validateStepsForActivation, validateTriggerForActivation } from '@/lib/automations/validate';

export const { GET } = collection(AUTOMATIONS);

export const POST = handler('automations:write', async (ctx, request) => {
  const raw = await readBody(request);
  const { steps: rawSteps, ...rest } = raw;
  const data = parseBody(
    rest,
    {
      name: { type: 'string', max: 120 },
      description: { type: 'text', max: 500, nullable: true },
      trigger_type: { type: 'enum', values: AUTOMATION_TRIGGER_TYPES },
      trigger_config: { type: 'json', check: isPlainObject },
      is_active: { type: 'bool' },
      template: { type: 'string', max: 80 },
    },
    { partial: false }
  );

  let name = data.name as string | undefined;
  let description = data.description as string | null | undefined;
  let triggerType = data.trigger_type as string | undefined;
  let triggerConfig = data.trigger_config as Record<string, unknown> | undefined;
  let steps = rawSteps === undefined ? undefined : (parseAutomationSteps(rawSteps) as BuilderStepInput[]);

  if (typeof data.template === 'string') {
    if (steps && steps.length > 0) throw badRequest("Send either 'template' or 'steps', not both");
    const tpl = getTemplate(data.template);
    if (!tpl) throw badRequest(`Unknown template '${data.template}'`);
    name = name ?? tpl.name;
    description = description ?? tpl.description;
    triggerType = triggerType ?? tpl.trigger_type;
    triggerConfig = triggerConfig ?? (tpl.trigger_config as unknown as Record<string, unknown>);
    steps = tpl.steps as unknown as BuilderStepInput[];
  }
  if (!name || !triggerType) throw badRequest("'name' and 'trigger_type' are required (or send 'template')");

  const isActive = data.is_active === true;
  if (isActive) {
    const issues = [
      ...validateTriggerForActivation(triggerType, triggerConfig ?? {}),
      ...validateStepsForActivation((steps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[]),
    ];
    if (issues.length > 0) {
      return Response.json(
        { error: { code: 'validation_failed', message: 'This automation cannot be activated yet. Fix the issues, or create it as a draft.', issues } },
        { status: 400 }
      );
    }
  }

  const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
  const { data: automation, error } = await ctx.supabase
    .from('automations')
    .insert({
      user_id: userId,
      account_id: ctx.accountId,
      name,
      description: description ?? null,
      trigger_type: triggerType,
      trigger_config: triggerConfig ?? {},
      is_active: isActive,
    })
    .select(AUTOMATIONS.select)
    .single();
  if (error || !automation) {
    console.error('[api/v1/automations] create error:', error);
    return fail('internal', 'Failed to create automation', 500);
  }
  const id = (automation as unknown as { id: string }).id;

  if (steps && steps.length > 0) {
    const err = await insertSteps(id, steps);
    if (err) {
      await ctx.supabase.from('automations').delete().eq('id', id).eq('account_id', ctx.accountId);
      console.error('[api/v1/automations] insert steps error:', err);
      return fail('internal', 'Failed to save automation steps', 500);
    }
  }

  await recordAudit(ctx, {
    action: 'automation.create',
    resourceType: 'automation',
    resourceId: id,
    fields: [...Object.keys(data), ...(rawSteps !== undefined ? ['steps'] : [])],
    detail: { is_active: isActive },
  });
  return ok(automation, 201);
});
