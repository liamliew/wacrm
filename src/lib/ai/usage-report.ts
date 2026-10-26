// ============================================================
// Token-spend report for the account's BYO AI key, shared by the
// dashboard (GET /api/ai/usage) and the public API (GET /api/v1/ai/usage).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveTimeZone,
  zonedDayKey,
  zonedDayStart,
  zonedLastNDayKeys,
} from '@/lib/ai/usage-days'
import { fetchPagesUpTo } from '@/lib/supabase/paged-query'

// Rows are aggregated in-process over a bounded window. An active
// account writes a handful of rows per conversation, so 30 days sits
// comfortably under this cap; we surface `truncated` when it doesn't so
// callers can say "partial window" rather than under-reporting silently.
const MAX_ROWS = 10_000
export const DEFAULT_WINDOW_DAYS = 30

interface UsageRow {
  created_at: string
  mode: 'auto_reply' | 'draft'
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** `?days=` → 1–90, default 30. A missing/blank param is Number('') === 0,
 *  which is finite — hence the `>= 1` guard rather than `isFinite` alone. */
export function parseUsageDays(raw: string | null): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.min(90, Math.floor(n)) : DEFAULT_WINDOW_DAYS
}

export async function buildUsageReport(
  db: SupabaseClient,
  accountId: string,
  opts: { days: number; tz: string | null },
) {
  const { days } = opts
  const timeZone = resolveTimeZone(opts.tz)
  const dayKeys = zonedLastNDayKeys(days, timeZone)
  const since = zonedDayStart(dayKeys[0], timeZone)

  const all = await fetchPagesUpTo<UsageRow>(
    (from, to) =>
      db
        .from('ai_usage_log')
        .select(
          'created_at, mode, provider, model, prompt_tokens, completion_tokens, total_tokens',
        )
        .eq('account_id', accountId)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    MAX_ROWS + 1,
  )

  const truncated = all.length > MAX_ROWS
  const rows = truncated ? all.slice(0, MAX_ROWS) : all

  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const byMode = {
    auto_reply: { calls: 0, tokens: 0 },
    draft: { calls: 0, tokens: 0 },
  }
  const modelMap = new Map<
    string,
    { model: string; provider: string; calls: number; tokens: number }
  >()
  // Zero-filled daily buckets so quiet days show as gaps, not missing points.
  const daily = new Map<string, { date: string; tokens: number; calls: number }>()
  for (const key of dayKeys) daily.set(key, { date: key, tokens: 0, calls: 0 })

  for (const r of rows) {
    promptTokens += r.prompt_tokens
    completionTokens += r.completion_tokens
    totalTokens += r.total_tokens
    byMode[r.mode].calls += 1
    byMode[r.mode].tokens += r.total_tokens

    const mk = `${r.provider}:${r.model}`
    const m = modelMap.get(mk) ?? { model: r.model, provider: r.provider, calls: 0, tokens: 0 }
    m.calls += 1
    m.tokens += r.total_tokens
    modelMap.set(mk, m)

    const bucket = daily.get(zonedDayKey(r.created_at, timeZone))
    if (bucket) {
      bucket.tokens += r.total_tokens
      bucket.calls += 1
    }
  }

  return {
    window_days: days,
    time_zone: timeZone,
    truncated,
    totals: {
      calls: rows.length,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
    by_mode: byMode,
    by_model: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
    daily: [...daily.values()],
  }
}
