// ============================================================
// Handoff hours + message — pure helpers, no I/O.
//
// When the AI hands a conversation to a human, the account can send the
// customer a message. Which one depends on whether the team is open at
// that moment (weekly hours in an IANA time zone), or on why the bot
// stopped (it hit the per-conversation reply cap).
//
// Hours are half-open: a range is open from `start` (inclusive) to `end`
// (exclusive), so exactly at the start it is open and exactly at the end
// it is closed. Overnight ranges (end before start) are not supported.
// ============================================================

import { isValidTimeZone } from '@/lib/automations/time-of-day'

export const DEFAULT_HANDOFF_TIME_ZONE = 'Asia/Kuala_Lumpur'

/** Longest message we store; WhatsApp text bodies allow far more. */
export const MAX_HANDOFF_MESSAGE_LENGTH = 1000

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

export interface DayHours {
  open: boolean
  /** 24-hour "HH:MM". */
  start: string
  end: string
}
export type WeeklyHours = Record<Weekday, DayHours>

/** What the editor starts from; it only counts once saved. */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: { open: true, start: '09:00', end: '18:00' },
  tue: { open: true, start: '09:00', end: '18:00' },
  wed: { open: true, start: '09:00', end: '18:00' },
  thu: { open: true, start: '09:00', end: '18:00' },
  fri: { open: true, start: '09:00', end: '18:00' },
  sat: { open: false, start: '09:00', end: '18:00' },
  sun: { open: false, start: '09:00', end: '18:00' },
}

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** "HH:MM" → minutes after midnight, or null when malformed. */
export function clockToMinutes(clock: unknown): number | null {
  if (typeof clock !== 'string') return null
  const m = CLOCK_RE.exec(clock)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export type HoursValidation =
  | { ok: true; hours: WeeklyHours }
  | { ok: false; day: Weekday | null; reason: 'shape' | 'time' | 'order' }

/**
 * Validate and normalise weekly hours from untrusted input (a request
 * body or a jsonb column). Every day must be present. Open days need
 * valid "HH:MM" times with the end after the start; closed days keep
 * whatever valid times they had (so toggling a day back on is lossless)
 * and fall back to the defaults when theirs are unusable.
 */
export function validateWeeklyHours(input: unknown): HoursValidation {
  if (!input || typeof input !== 'object') {
    return { ok: false, day: null, reason: 'shape' }
  }
  const raw = input as Record<string, unknown>
  const out = {} as WeeklyHours
  for (const day of WEEKDAYS) {
    const d = raw[day]
    if (!d || typeof d !== 'object' || typeof (d as DayHours).open !== 'boolean') {
      return { ok: false, day, reason: 'shape' }
    }
    const { open, start, end } = d as DayHours
    const s = clockToMinutes(start)
    const e = clockToMinutes(end)
    if (open) {
      if (s === null || e === null) return { ok: false, day, reason: 'time' }
      if (e <= s) return { ok: false, day, reason: 'order' }
      out[day] = { open, start, end }
    } else {
      out[day] =
        s !== null && e !== null && e > s
          ? { open, start, end }
          : { open, start: DEFAULT_WEEKLY_HOURS[day].start, end: DEFAULT_WEEKLY_HOURS[day].end }
    }
  }
  return { ok: true, hours: out }
}

/** Parse a stored jsonb value; anything unusable counts as "not set". */
export function parseStoredHours(value: unknown): WeeklyHours | null {
  if (value === null || value === undefined) return null
  const v = validateWeeklyHours(value)
  return v.ok ? v.hours : null
}

// ---------------------------------------------------------------
// Time zone arithmetic
// ---------------------------------------------------------------

const WEEKDAY_FROM_SHORT: Record<string, Weekday> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
}

/** The weekday and minutes-after-midnight at `now` in `timeZone`. */
export function localClock(now: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_HANDOFF_TIME_ZONE
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    weekday: WEEKDAY_FROM_SHORT[get('weekday')] ?? 'mon',
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  }
}

/** Offset of `timeZone` from UTC at `at`, in minutes (east is positive). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'))
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000)
}

/**
 * The instant at which the wall clock in `timeZone` reads `local`
 * ("YYYY-MM-DDTHH:mm", what a datetime-local input produces). Used by the
 * preview's test-time picker. Null when `local` is malformed. In the hour
 * a daylight-saving change skips or repeats, the result is the nearest
 * valid instant.
 */
export function wallTimeToDate(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!m) return null
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_HANDOFF_TIME_ZONE
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  if (Number.isNaN(asUtc)) return null
  let guess = new Date(asUtc - zoneOffsetMinutes(new Date(asUtc), zone) * 60000)
  guess = new Date(asUtc - zoneOffsetMinutes(guess, zone) * 60000)
  return guess
}

function rangeOf(day: DayHours): [number, number] | null {
  if (!day.open) return null
  const s = clockToMinutes(day.start)
  const e = clockToMinutes(day.end)
  return s !== null && e !== null && e > s ? [s, e] : null
}

/**
 * Is the team open at `now`? `hours: null` (not configured) counts as
 * open, matching "no hours set → use the open message".
 */
export function isOpen(now: Date, timeZone: string, hours: WeeklyHours | null): boolean {
  if (!hours) return true
  const { weekday, minutes } = localClock(now, timeZone)
  const range = rangeOf(hours[weekday])
  return range !== null && minutes >= range[0] && minutes < range[1]
}

export interface NextOpen {
  /** 0 = later today, 1 = tomorrow, 2..7 = further ahead (7 = same weekday next week). */
  dayOffset: number
  weekday: Weekday
  /** Opening time, minutes after midnight. */
  minutes: number
}

/** The next time the team opens after `now`, or null with no hours / no open day. */
export function nextOpen(now: Date, timeZone: string, hours: WeeklyHours | null): NextOpen | null {
  if (!hours) return null
  const { weekday, minutes } = localClock(now, timeZone)
  const today = WEEKDAYS.indexOf(weekday)
  for (let offset = 0; offset <= 7; offset++) {
    const day = WEEKDAYS[(today + offset) % 7]
    const range = rangeOf(hours[day])
    if (!range) continue
    if (offset === 0 && minutes >= range[0]) continue // today's opening has passed
    return { dayOffset: offset, weekday: day, minutes: range[0] }
  }
  return null
}

// ---------------------------------------------------------------
// Wording
// ---------------------------------------------------------------

/** 600 → "10am", 570 → "9:30am", 720 → "12pm", 0 → "12am". */
export function formatTime(totalMinutes: number): string {
  const h24 = Math.floor(totalMinutes / 60) % 24
  const m = totalMinutes % 60
  const suffix = h24 < 12 ? 'am' : 'pm'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`
}

/** "today", "tomorrow", or "on Monday". */
export function formatDay(next: NextOpen): string {
  if (next.dayOffset === 0) return 'today'
  if (next.dayOffset === 1) return 'tomorrow'
  return `on ${WEEKDAY_NAMES[next.weekday]}`
}

export interface PlaceholderValues {
  nextOpenDay: string
  nextOpenTime: string
  hoursToday: string
}

export function placeholderValues(
  now: Date,
  timeZone: string,
  hours: WeeklyHours | null,
): PlaceholderValues {
  const next = nextOpen(now, timeZone, hours)
  const { weekday } = localClock(now, timeZone)
  const range = hours ? rangeOf(hours[weekday]) : null
  return {
    // With no open day at all there is nothing to promise.
    nextOpenDay: next ? formatDay(next) : 'soon',
    nextOpenTime: next ? formatTime(next.minutes) : '',
    hoursToday: range ? `${formatTime(range[0])}–${formatTime(range[1])}` : 'closed today',
  }
}

export const HANDOFF_PLACEHOLDERS = ['{{next_open_day}}', '{{next_open_time}}', '{{hours_today}}'] as const

/** Fill `{{next_open_day}}`, `{{next_open_time}}` and `{{hours_today}}`. */
export function renderHandoffMessage(template: string, values: PlaceholderValues): string {
  let text = template.replace(
    /\{\{\s*(next_open_day|next_open_time|hours_today)\s*\}\}/g,
    (_, key: string) =>
      key === 'next_open_day'
        ? values.nextOpenDay
        : key === 'next_open_time'
          ? values.nextOpenTime
          : values.hoursToday,
  )
  if (values.nextOpenTime === '') {
    // "…back soon at ." → "…back soon."
    text = text.replace(/\s+(?:at|by|from|until|after)\s*(?=[.,!?;:]|\s*$)/gi, '')
  }
  return text.replace(/[ \t]{2,}/g, ' ').trim()
}

// ---------------------------------------------------------------
// Choosing the message
// ---------------------------------------------------------------

export interface HandoffSettings {
  timeZone: string
  /** null = not configured. */
  hours: WeeklyHours | null
  enabled: boolean
  /** Sent when the AI hands off while the team is open (or hours are not set). */
  openMessage: string
  /** Sent when the AI hands off while the team is closed. */
  closedMessage: string
  /** Sent when the bot stops because it reached its reply limit. */
  capMessage: string
}

export type HandoffReason = 'model' | 'cap'

export interface ResolvedHandoffMessage {
  /** Send it? False when the feature is off or the chosen message is blank. */
  send: boolean
  /** Which message was chosen. */
  which: 'open' | 'closed' | 'cap'
  /** Whether the team is open at `now` (true when hours are not set). */
  open: boolean
  /** Hours are not configured, so the open message was used. */
  hoursMissing: boolean
  /** Placeholders filled in. */
  text: string
}

export function resolveHandoffMessage(args: {
  settings: HandoffSettings
  reason: HandoffReason
  now: Date
}): ResolvedHandoffMessage {
  const { settings, reason, now } = args
  const open = isOpen(now, settings.timeZone, settings.hours)
  const which = reason === 'cap' ? 'cap' : open ? 'open' : 'closed'
  const template =
    which === 'cap'
      ? settings.capMessage
      : which === 'open'
        ? settings.openMessage
        : settings.closedMessage
  const text = renderHandoffMessage(
    template,
    placeholderValues(now, settings.timeZone, settings.hours),
  )
  return {
    send: settings.enabled && text !== '',
    which,
    open,
    hoursMissing: settings.hours === null,
    text,
  }
}
