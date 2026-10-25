import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidTimeZone } from '@/lib/automations/time-of-day'
import {
  DEFAULT_HANDOFF_TIME_ZONE,
  parseStoredHours,
  type HandoffSettings,
} from './handoff-hours'

/** The `ai_configs` columns behind the Handoff tab (migration 060). */
export const HANDOFF_COLUMNS =
  'handoff_timezone, handoff_hours, handoff_message_enabled, handoff_open_message, handoff_closed_message, handoff_cap_message'

export interface HandoffSettingsRow {
  handoff_timezone: string | null
  handoff_hours: unknown
  handoff_message_enabled: boolean | null
  handoff_open_message: string | null
  handoff_closed_message: string | null
  handoff_cap_message: string | null
}

/** Row → settings, tolerating nulls and an unusable zone or hours value. */
export function toHandoffSettings(row: HandoffSettingsRow): HandoffSettings {
  return {
    timeZone: isValidTimeZone(row.handoff_timezone)
      ? row.handoff_timezone
      : DEFAULT_HANDOFF_TIME_ZONE,
    hours: parseStoredHours(row.handoff_hours),
    enabled: row.handoff_message_enabled === true,
    openMessage: row.handoff_open_message ?? '',
    closedMessage: row.handoff_closed_message ?? '',
    capMessage: row.handoff_cap_message ?? '',
  }
}

/**
 * Load the account's handoff settings. Returns null when there is no AI
 * config row or the read fails (for example migration 060 is not applied
 * yet) — the caller then simply sends no message; the handoff itself is
 * never affected.
 */
export async function loadHandoffSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<HandoffSettings | null> {
  const { data, error } = await db
    .from('ai_configs')
    .select(HANDOFF_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[ai handoff] could not load handoff settings:', error)
    return null
  }
  return data ? toHandoffSettings(data as unknown as HandoffSettingsRow) : null
}
