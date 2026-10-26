import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { syncTemplates } from '@/lib/whatsapp/template-sync'

/**
 * Sync message templates from Meta → local message_templates table
 * (admin+). The work lives in `lib/whatsapp/template-sync.ts`, shared
 * with the public API (`POST /api/v1/templates/sync`).
 *
 * Syncing rewrites the account-wide template catalog, which is
 * settings-class data: `canEditSettings` and the message_templates
 * insert/update RLS policies (migration 017) both require 'admin'.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const auth = await requireRole('admin')
    const limit = checkRateLimit(`whatsapp-admin:${auth.userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    return await syncTemplates(auth)
  } catch (err) {
    return toErrorResponse(err)
  }
}
