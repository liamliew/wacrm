import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { buildUsageReport, parseUsageDays } from '@/lib/ai/usage-report'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/ai/usage?days=30&tz=Europe/Vilnius  (admin+)
 *
 * Token-spend summary for the account's BYO key over the last `days`
 * (1–90, default 30): totals, per-mode + per-model breakdowns, and a
 * zero-filled daily series for charting. Admin-only, mirroring the
 * `ai_usage_log` SELECT policy — spend is billing-class. The report
 * itself lives in `lib/ai/usage-report.ts` (shared with /api/v1/ai/usage).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const url = new URL(request.url)
    try {
      const report = await buildUsageReport(supabase, accountId, {
        days: parseUsageDays(url.searchParams.get('days')),
        tz: url.searchParams.get('tz'),
      })
      return NextResponse.json(report)
    } catch (error) {
      console.error('[ai/usage GET] fetch error:', error)
      return NextResponse.json({ error: t('ai.loadUsageFailed') }, { status: 500 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
