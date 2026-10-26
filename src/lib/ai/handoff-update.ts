// ============================================================
// Validation of a handoff-settings update, shared by the dashboard
// (PUT /api/ai/handoff) and the public API (PATCH /api/v1/ai/config) so
// both apply exactly the same rules.
//
// Pure apart from the injected `isMember` lookup. Every field is
// optional; an absent field is left unchanged. Errors carry the key of
// an `Api.ai.*` message (and its params) so each caller can render them
// in its own envelope.
// ============================================================

import { isValidTimeZone } from '@/lib/automations/time-of-day'
import { MAX_HANDOFF_MESSAGE_LENGTH, validateWeeklyHours } from './handoff-hours'

export interface HandoffUpdateError {
  /** Key under `Api.ai` in messages/*.json. */
  key:
    | 'handoffNotMember'
    | 'handoffTimeZoneInvalid'
    | 'handoffHoursOrder'
    | 'handoffHoursInvalid'
    | 'handoffEnabledInvalid'
    | 'handoffMessageInvalid'
    | 'handoffMessageTooLong'
  params?: Record<string, string | number>
}

export type HandoffUpdateResult =
  | { ok: true; update: Record<string, unknown> }
  | { ok: false; error: HandoffUpdateError }

/** Body fields this parser understands. */
export const HANDOFF_BODY_FIELDS = [
  'handoff_agent_id',
  'timezone',
  'hours',
  'message_enabled',
  'open_message',
  'closed_message',
  'cap_message',
] as const

const MESSAGE_FIELDS = [
  ['open_message', 'handoff_open_message'],
  ['closed_message', 'handoff_closed_message'],
  ['cap_message', 'handoff_cap_message'],
] as const

export async function parseHandoffUpdate(
  body: Record<string, unknown>,
  deps: { isMember: (userId: string) => Promise<boolean> },
): Promise<HandoffUpdateResult> {
  const update: Record<string, unknown> = {}
  const err = (error: HandoffUpdateError): HandoffUpdateResult => ({ ok: false, error })

  if ('handoff_agent_id' in body) {
    const raw =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    if (raw) {
      if (!(await deps.isMember(raw))) return err({ key: 'handoffNotMember' })
      update.handoff_agent_id = raw
    } else {
      update.handoff_agent_id = null
    }
  }

  if ('timezone' in body) {
    if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone.trim())) {
      return err({ key: 'handoffTimeZoneInvalid' })
    }
    update.handoff_timezone = body.timezone.trim()
  }

  if ('hours' in body) {
    if (body.hours === null) {
      update.handoff_hours = null
    } else {
      const v = validateWeeklyHours(body.hours)
      if (!v.ok) {
        return err(
          v.reason === 'order'
            ? { key: 'handoffHoursOrder', params: { day: v.day ?? '' } }
            : { key: 'handoffHoursInvalid' },
        )
      }
      update.handoff_hours = v.hours
    }
  }

  if ('message_enabled' in body) {
    if (typeof body.message_enabled !== 'boolean') return err({ key: 'handoffEnabledInvalid' })
    update.handoff_message_enabled = body.message_enabled
  }

  for (const [field, column] of MESSAGE_FIELDS) {
    if (!(field in body)) continue
    const value = body[field]
    if (value !== null && typeof value !== 'string') return err({ key: 'handoffMessageInvalid' })
    const text = typeof value === 'string' ? value.trim() : ''
    if (text.length > MAX_HANDOFF_MESSAGE_LENGTH) {
      return err({ key: 'handoffMessageTooLong', params: { max: MAX_HANDOFF_MESSAGE_LENGTH } })
    }
    update[column] = text === '' ? null : text
  }

  return { ok: true, update }
}
