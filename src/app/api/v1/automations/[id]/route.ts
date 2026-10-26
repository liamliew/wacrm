// ============================================================
// GET    /api/v1/automations/{id} — automation with its step tree (automations:read)
// PATCH  /api/v1/automations/{id} — edit; `steps` REPLACES the whole tree (automations:write)
// DELETE /api/v1/automations/{id} — delete it and its logs         (automations:write)
//
// Anything left ACTIVE after a PATCH is validated first (400 + issues).
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { AUTOMATION_TRIGGER_TYPES, isPlainObject, parseAutomationSteps, redactSteps } from '@/lib/api/v1/flow-inputs';
import { AUTOMATIONS } from '@/lib/api/v1/resources';
import { loadStepsTree, replaceSteps, type BuilderStepInput } from '@/lib/automations/steps-tree';
import { validateStepsForActivation, validateTriggerForActivation } from '@/lib/automations/validate';
import type { ApiKeyContext } from '@/lib/auth/api-context';

const notFound = () => fail('not_found', 'Automation not found', 404);

async function loadAutomation(ctx: ApiKeyContext, id: string) {
  if (!isUuidString(id)) return null;
  const { data } = await ctx.supabase
    .from('automations')
    .select(AUTOMATIONS.select)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return (data as unknown as Record<string, unknown> | null) ?? null;
}

export const GET = handler<{ id: string }>('automations:read', async (ctx, _req, { id }) => {
  const automation = await loadAutomation(ctx, id);
  if (!automation) return notFound();
  return ok({ automation, steps: redactSteps(await loadStepsTree(id)) });
});

export const PATCH = handler<{ id: string }>('automations:write', async (ctx, request, { id }) => {
  const raw = await readBody(request);
  const { steps: rawSteps, ...rest } = raw;
  const data = parseBody(
    rest,
    {
      name: { type: 'string', min: 1, max: 120 },
      description: { type: 'text', max: 500, nullable: true },
      trigger_type: { type: 'enum', values: AUTOMATION_TRIGGER_TYPES },
      trigger_config: { type: 'json', check: isPlainObject },
      is_active: { type: 'bool' },
    },
    { partial: true, allowEmpty: true }
  );
  const steps = rawSteps === undefined ? undefined : (parseAutomationSteps(rawSteps) as BuilderStepInput[]);
  if (Object.keys(data).length === 0 && steps === undefined) {
    throw badRequest('Nothing to update: send at least one field or steps');
  }

  const existing = await loadAutomation(ctx, id);
  if (!existing) return notFound();

  const willBeActive = typeof data.is_active === 'boolean' ? data.is_active : existing.is_active === true;
  if (willBeActive) {
    const issues = [
      ...validateTriggerForActivation(
        ((data.trigger_type as string | undefined) ?? existing.trigger_type) as string,
        (data.trigger_config as Record<string, unknown> | undefined) ?? (existing.trigger_config as Record<string, unknown>)
      ),
      ...validateStepsForActivation(
        (steps ?? (await loadStepsTree(id))) as unknown as { step_type: string; step_config: Record<string, unknown> }[]
      ),
    ];
    if (issues.length > 0) {
      return Response.json(
        { error: { code: 'validation_failed', message: 'This automation would be invalid while active. Fix the issues, or set is_active to false.', issues } },
        { status: 400 }
      );
    }
  }

  if (Object.keys(data).length > 0) {
    const { error } = await ctx.supabase
      .from('automations')
      .update(data)
      .eq('id', id)
      .eq('account_id', ctx.accountId);
    if (error) {
      console.error('[api/v1/automations] update error:', error);
      return fail('internal', 'Failed to update automation', 500);
    }
  }
  if (steps !== undefined) {
    const err = await replaceSteps(id, steps);
    if (err) {
      console.error('[api/v1/automations] replace steps error:', err);
      return fail('internal', 'Failed to save automation steps', 500);
    }
  }

  await recordAudit(ctx, {
    action: 'automation.update',
    resourceType: 'automation',
    resourceId: id,
    fields: [...Object.keys(data), ...(steps !== undefined ? ['steps'] : [])],
  });
  const updated = await loadAutomation(ctx, id);
  return ok({ automation: updated, steps: redactSteps(await loadStepsTree(id)) });
});

export const DELETE = handler<{ id: string }>('automations:write', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return notFound();
  const { data, error } = await ctx.supabase
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id');
  if (error) return fail('internal', 'Failed to delete automation', 500);
  if (!data || data.length === 0) return notFound();
  await recordAudit(ctx, { action: 'automation.delete', resourceType: 'automation', resourceId: id });
  return ok({ id, deleted: true });
});
