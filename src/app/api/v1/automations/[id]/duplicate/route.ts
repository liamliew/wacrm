// POST /api/v1/automations/{id}/duplicate (automations:write) — an inactive copy ("Copy of …").
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { AUTOMATIONS } from '@/lib/api/v1/resources';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');

export const POST = handler<{ id: string }>('automations:write', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return fail('not_found', 'Automation not found', 404);
  const { data: original } = await ctx.supabase
    .from('automations')
    .select('name, description, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!original) return fail('not_found', 'Automation not found', 404);

  const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
  const { data: copy, error } = await ctx.supabase
    .from('automations')
    .insert({
      account_id: ctx.accountId,
      user_id: userId,
      name: t('automations.copyName', { name: original.name }),
      description: original.description,
      trigger_type: original.trigger_type,
      trigger_config: original.trigger_config,
      is_active: false,
    })
    .select(AUTOMATIONS.select)
    .single();
  if (error || !copy) return fail('internal', 'Failed to duplicate automation', 500);
  const copyId = (copy as unknown as { id: string }).id;

  const { data: steps } = await ctx.supabase
    .from('automation_steps')
    .select('id, parent_step_id, branch, step_type, step_config, position')
    .eq('automation_id', id)
    .order('position', { ascending: true });
  if (steps && steps.length > 0) {
    const idMap = new Map<string, string>(steps.map((r) => [r.id as string, crypto.randomUUID()]));
    const { error: insErr } = await ctx.supabase.from('automation_steps').insert(
      steps.map((r) => ({
        id: idMap.get(r.id as string)!,
        automation_id: copyId,
        parent_step_id: r.parent_step_id ? idMap.get(r.parent_step_id as string) : null,
        branch: r.branch,
        step_type: r.step_type,
        step_config: r.step_config,
        position: r.position,
      }))
    );
    if (insErr) {
      await ctx.supabase.from('automations').delete().eq('id', copyId).eq('account_id', ctx.accountId);
      return fail('internal', 'Failed to copy automation steps', 500);
    }
  }
  await recordAudit(ctx, { action: 'automation.duplicate', resourceType: 'automation', resourceId: copyId, detail: { source: id } });
  return ok(copy, 201);
});
