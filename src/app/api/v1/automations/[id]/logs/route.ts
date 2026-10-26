// GET /api/v1/automations/{id}/logs (automations:read) — the 50 most recent runs, newest first.
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString } from '@/lib/api/v1/input';

export const GET = handler<{ id: string }>('automations:read', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return fail('not_found', 'Automation not found', 404);
  const { data: a } = await ctx.supabase.from('automations').select('id').eq('id', id).eq('account_id', ctx.accountId).maybeSingle();
  if (!a) return fail('not_found', 'Automation not found', 404);
  const { data, error } = await ctx.supabase
    .from('automation_logs')
    .select('id, contact_id, trigger_event, steps_executed, status, error_message, created_at')
    .eq('automation_id', id)
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return fail('internal', 'Failed to list automation logs', 500);
  return ok(data ?? []);
});
