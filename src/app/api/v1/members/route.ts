// GET /api/v1/members  (scope members:read)
// The team: user id (use it for assigned_agent_id), name, email, role.
// Read-only on purpose — inviting, removing and changing roles stay in the dashboard.
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';

export const GET = handler('members:read', async (ctx) => {
  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('user_id, full_name, email, account_role, created_at')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[api/v1/members] list error:', error);
    return fail('internal', 'Failed to list members', 500);
  }
  return ok(
    (data ?? []).map((m) => ({
      user_id: m.user_id,
      name: m.full_name ?? '',
      email: m.email ?? null,
      role: m.account_role,
      joined_at: m.created_at,
    }))
  );
});
