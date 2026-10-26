// POST /api/v1/templates/sync  (templates:write)
// Pull the account's templates and their approval status from Meta into the local catalog.
import { handler } from '@/lib/api/v1/route';
import { rateLimited } from '@/lib/api/v1/respond';
import { adaptDashboardResponse } from '@/lib/api/v1/adapt';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { syncTemplates } from '@/lib/whatsapp/template-sync';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export const POST = handler('templates:write', async (ctx) => {
  const limit = checkRateLimit(`apikey-wa-admin:${ctx.keyId}`, RATE_LIMITS.whatsappAdmin);
  if (!limit.success) throw rateLimited(limit);

  const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
  const res = await syncTemplates({ supabase: ctx.supabase, accountId: ctx.accountId, userId });
  if (res.ok) await recordAudit(ctx, { action: 'template.sync', resourceType: 'template' });
  return adaptDashboardResponse(res);
});
