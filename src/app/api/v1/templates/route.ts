// ============================================================
// GET  /api/v1/templates — list WhatsApp message templates   (templates:read)
//      filters: ?status=APPROVED ?language=en_US ?category=Utility
// POST /api/v1/templates — submit a NEW template to Meta for approval (templates:write)
//      body: the same payload as the dashboard's template form
//      (name, category, language, body_text, header_*, footer_text, buttons, sample_values).
//      Runs the same validation + Meta submission as the dashboard.
// ============================================================

import { collection } from '@/lib/api/v1/crud';
import { TEMPLATES } from '@/lib/api/v1/resources';
import { handler } from '@/lib/api/v1/route';
import { rateLimited } from '@/lib/api/v1/respond';
import { adaptDashboardResponse } from '@/lib/api/v1/adapt';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { submitTemplate } from '@/lib/whatsapp/template-submit';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export const { GET } = collection(TEMPLATES);

export const POST = handler('templates:write', async (ctx, request) => {
  const limit = checkRateLimit(`apikey-wa-admin:${ctx.keyId}`, RATE_LIMITS.whatsappAdmin);
  if (!limit.success) throw rateLimited(limit);

  const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
  const res = await submitTemplate(request, { supabase: ctx.supabase, accountId: ctx.accountId, userId });
  if (res.ok) {
    await recordAudit(ctx, { action: 'template.submit', resourceType: 'template' });
  }
  return adaptDashboardResponse(res);
});
