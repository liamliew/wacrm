import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isValidTimeZone } from '@/lib/automations/time-of-day'
import {
  MAX_HANDOFF_MESSAGE_LENGTH,
  validateWeeklyHours,
} from '@/lib/ai/handoff-hours'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * PUT /api/ai/handoff  (admin+)
 *
 * Save everything on the AI Assistant → Handoff tab in one update: the
 * handoff target (`ai_configs.handoff_agent_id`, same value and same
 * member check as POST /api/ai/config) and the hours + customer-message
 * settings from migration 060. Every field is optional; an absent field
 * is left unchanged. Reading goes through GET /api/ai/config.
 *
 * Body: {
 *   handoff_agent_id?: string | null,   // null / "" = unassigned queue
 *   timezone?: string,                  // IANA, e.g. "Asia/Kuala_Lumpur"
 *   hours?: WeeklyHours | null,         // null = not set
 *   message_enabled?: boolean,
 *   open_message?: string | null,
 *   closed_message?: string | null,
 *   cap_message?: string | null,
 * }
 *
 * The AI provider must already be set up (the settings live on the same
 * row as the key), otherwise 409.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-handoff:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return bad(t('common.invalidRequestBody'))
    }

    const update: Record<string, unknown> = {}

    if ('handoff_agent_id' in body) {
      const raw =
        typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
      if (raw) {
        const { data: member } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('account_id', accountId)
          .eq('user_id', raw)
          .maybeSingle()
        if (!member) return bad(t('ai.handoffNotMember'))
        update.handoff_agent_id = raw
      } else {
        update.handoff_agent_id = null
      }
    }

    if ('timezone' in body) {
      if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone.trim())) {
        return bad(t('ai.handoffTimeZoneInvalid'))
      }
      update.handoff_timezone = body.timezone.trim()
    }

    if ('hours' in body) {
      if (body.hours === null) {
        update.handoff_hours = null
      } else {
        const v = validateWeeklyHours(body.hours)
        if (!v.ok) {
          return bad(
            v.reason === 'order'
              ? t('ai.handoffHoursOrder', { day: v.day ?? '' })
              : t('ai.handoffHoursInvalid'),
          )
        }
        update.handoff_hours = v.hours
      }
    }

    if ('message_enabled' in body) {
      if (typeof body.message_enabled !== 'boolean') {
        return bad(t('ai.handoffEnabledInvalid'))
      }
      update.handoff_message_enabled = body.message_enabled
    }

    for (const [field, column] of [
      ['open_message', 'handoff_open_message'],
      ['closed_message', 'handoff_closed_message'],
      ['cap_message', 'handoff_cap_message'],
    ] as const) {
      if (!(field in body)) continue
      const value = body[field]
      if (value !== null && typeof value !== 'string') {
        return bad(t('ai.handoffMessageInvalid'))
      }
      const text = typeof value === 'string' ? value.trim() : ''
      if (text.length > MAX_HANDOFF_MESSAGE_LENGTH) {
        return bad(t('ai.handoffMessageTooLong', { max: MAX_HANDOFF_MESSAGE_LENGTH }))
      }
      update[column] = text === '' ? null : text
    }

    if (Object.keys(update).length === 0) return bad(t('ai.handoffNothingToUpdate'))

    const { data, error } = await supabase
      .from('ai_configs')
      .update(update)
      .eq('account_id', accountId)
      .select('account_id')
    if (error) {
      console.error('[ai/handoff PUT] update error:', error)
      return NextResponse.json({ error: t('ai.saveHandoffFailed') }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: t('ai.handoffNeedsSetup') }, { status: 409 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
