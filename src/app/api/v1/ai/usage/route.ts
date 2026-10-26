// GET /api/v1/ai/usage?days=30&tz=Asia/Kuala_Lumpur  (scope ai:read)
// Token spend on the account's AI key: totals, per-mode, per-model, daily.
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { buildUsageReport, parseUsageDays } from '@/lib/ai/usage-report';

export const GET = handler('ai:read', async (ctx, request) => {
  const url = new URL(request.url);
  try {
    return ok(
      await buildUsageReport(ctx.supabase, ctx.accountId, {
        days: parseUsageDays(url.searchParams.get('days')),
        tz: url.searchParams.get('tz'),
      })
    );
  } catch (err) {
    console.error('[api/v1/ai/usage] error:', err);
    return fail('internal', 'Failed to load usage', 500);
  }
});
