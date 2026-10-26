import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { submitTemplate } from '@/lib/whatsapp/template-submit'

/**
 * Submit a template to Meta for approval AND persist it locally
 * (admin+). The work lives in `lib/whatsapp/template-submit.ts` so the
 * public API (`POST /api/v1/templates`) runs exactly the same code.
 *
 * Message templates are settings-class data: `canEditSettings` and the
 * message_templates_insert/update RLS policies (migration 017) both
 * require 'admin'. Resolving account_id off the profile only proved
 * membership, so a viewer or agent could push a template to Meta for
 * approval — an external side effect RLS can't roll back — before the
 * local upsert was refused.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const auth = await requireRole('admin')
    const limit = checkRateLimit(`whatsapp-admin:${auth.userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    return await submitTemplate(request, auth)
  } catch (err) {
    return toErrorResponse(err)
  }
}
