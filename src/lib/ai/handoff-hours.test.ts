import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WEEKLY_HOURS,
  clockToMinutes,
  formatTime,
  isOpen,
  localClock,
  nextOpen,
  parseStoredHours,
  renderHandoffMessage,
  resolveHandoffMessage,
  validateWeeklyHours,
  wallTimeToDate,
  type HandoffSettings,
  type WeeklyHours,
} from './handoff-hours'

const KL = 'Asia/Kuala_Lumpur' // UTC+8, no daylight saving

/** An instant given as Kuala Lumpur wall-clock time. 2026-10-26 is a Monday. */
const kl = (iso: string) => new Date(`${iso}+08:00`)

const WEEKDAYS_9_TO_6: WeeklyHours = DEFAULT_WEEKLY_HOURS // Mon–Fri 09:00–18:00
const ALL_CLOSED: WeeklyHours = Object.fromEntries(
  Object.entries(DEFAULT_WEEKLY_HOURS).map(([d, v]) => [d, { ...v, open: false }]),
) as WeeklyHours

describe('isOpen — boundaries', () => {
  it('is open exactly at the opening time', () => {
    expect(isOpen(kl('2026-10-26T09:00:00'), KL, WEEKDAYS_9_TO_6)).toBe(true)
  })
  it('is closed one minute before opening', () => {
    expect(isOpen(kl('2026-10-26T08:59:00'), KL, WEEKDAYS_9_TO_6)).toBe(false)
  })
  it('is open one minute before closing', () => {
    expect(isOpen(kl('2026-10-26T17:59:00'), KL, WEEKDAYS_9_TO_6)).toBe(true)
  })
  it('is closed exactly at the closing time', () => {
    expect(isOpen(kl('2026-10-26T18:00:00'), KL, WEEKDAYS_9_TO_6)).toBe(false)
  })
  it('is still open at 17:59:59', () => {
    expect(isOpen(kl('2026-10-26T17:59:59'), KL, WEEKDAYS_9_TO_6)).toBe(true)
  })
})

describe('weekends and closed days', () => {
  it('is closed all day Saturday and Sunday', () => {
    expect(isOpen(kl('2026-10-24T12:00:00'), KL, WEEKDAYS_9_TO_6)).toBe(false) // Sat
    expect(isOpen(kl('2026-10-25T12:00:00'), KL, WEEKDAYS_9_TO_6)).toBe(false) // Sun
  })
  it('next opening from Sunday is tomorrow (Monday) at 9am', () => {
    expect(nextOpen(kl('2026-10-25T12:00:00'), KL, WEEKDAYS_9_TO_6)).toEqual({
      dayOffset: 1, weekday: 'mon', minutes: 540,
    })
  })
  it('next opening from Friday evening is Monday, three days ahead', () => {
    expect(nextOpen(kl('2026-10-30T19:00:00'), KL, WEEKDAYS_9_TO_6)).toEqual({
      dayOffset: 3, weekday: 'mon', minutes: 540,
    })
  })
  it('next opening before today’s start is later today', () => {
    expect(nextOpen(kl('2026-10-26T07:30:00'), KL, WEEKDAYS_9_TO_6)).toEqual({
      dayOffset: 0, weekday: 'mon', minutes: 540,
    })
  })
  it('next opening exactly at the start skips to the following day (it is open now)', () => {
    expect(nextOpen(kl('2026-10-26T09:00:00'), KL, WEEKDAYS_9_TO_6)?.dayOffset).toBe(1)
  })
  it('a single open day wraps to the same weekday next week', () => {
    const mondayOnly: WeeklyHours = {
      ...ALL_CLOSED,
      mon: { open: true, start: '10:00', end: '12:00' },
    }
    expect(nextOpen(kl('2026-10-26T13:00:00'), KL, mondayOnly)).toEqual({
      dayOffset: 7, weekday: 'mon', minutes: 600,
    })
  })
})

describe('all days closed / no hours set', () => {
  it('is never open and has no next opening when every day is closed', () => {
    expect(isOpen(kl('2026-10-26T10:00:00'), KL, ALL_CLOSED)).toBe(false)
    expect(nextOpen(kl('2026-10-26T10:00:00'), KL, ALL_CLOSED)).toBeNull()
  })
  it('treats unset hours as open with no next opening', () => {
    expect(isOpen(kl('2026-10-25T03:00:00'), KL, null)).toBe(true)
    expect(nextOpen(kl('2026-10-25T03:00:00'), KL, null)).toBeNull()
  })
})

describe('time zones', () => {
  it('evaluates the same instant differently per zone', () => {
    const instant = new Date('2026-10-26T02:00:00Z') // 10:00 KL, 22:00 prev day New York (EDT)
    expect(isOpen(instant, KL, WEEKDAYS_9_TO_6)).toBe(true)
    expect(isOpen(instant, 'America/New_York', WEEKDAYS_9_TO_6)).toBe(false)
    expect(localClock(instant, 'America/New_York')).toEqual({ weekday: 'sun', minutes: 22 * 60 })
  })
  it('handles half-hour offsets (India, UTC+5:30)', () => {
    const instant = new Date('2026-10-26T03:30:00Z') // 09:00 in Kolkata
    expect(localClock(instant, 'Asia/Kolkata')).toEqual({ weekday: 'mon', minutes: 540 })
    expect(isOpen(instant, 'Asia/Kolkata', WEEKDAYS_9_TO_6)).toBe(true)
    expect(isOpen(new Date('2026-10-26T03:29:00Z'), 'Asia/Kolkata', WEEKDAYS_9_TO_6)).toBe(false)
  })
  it('follows daylight saving: New York 9am is 13:00Z in summer and 14:00Z in winter', () => {
    expect(isOpen(new Date('2026-07-06T13:00:00Z'), 'America/New_York', WEEKDAYS_9_TO_6)).toBe(true)
    expect(isOpen(new Date('2026-07-06T12:59:00Z'), 'America/New_York', WEEKDAYS_9_TO_6)).toBe(false)
    expect(isOpen(new Date('2026-12-07T14:00:00Z'), 'America/New_York', WEEKDAYS_9_TO_6)).toBe(true)
    expect(isOpen(new Date('2026-12-07T13:59:00Z'), 'America/New_York', WEEKDAYS_9_TO_6)).toBe(false)
  })
  it('falls back to Kuala Lumpur for an invalid zone instead of throwing', () => {
    expect(localClock(kl('2026-10-26T10:00:00'), 'Not/AZone')).toEqual({ weekday: 'mon', minutes: 600 })
  })
})

describe('formatting', () => {
  it('formats times in 10am style', () => {
    expect(formatTime(0)).toBe('12am')
    expect(formatTime(540)).toBe('9am')
    expect(formatTime(570)).toBe('9:30am')
    expect(formatTime(720)).toBe('12pm')
    expect(formatTime(18 * 60)).toBe('6pm')
    expect(formatTime(23 * 60 + 5)).toBe('11:05pm')
  })
})

describe('renderHandoffMessage / resolveHandoffMessage', () => {
  const settings: HandoffSettings = {
    timeZone: KL,
    hours: WEEKDAYS_9_TO_6,
    enabled: true,
    openMessage: 'Connecting you to a teammate. We are open {{hours_today}}.',
    closedMessage: 'We are closed. We will reply {{next_open_day}} at {{next_open_time}}.',
    capMessage: 'We will take it from here. Hours today: {{hours_today}}.',
  }

  it('says tomorrow with a 10am-style time', () => {
    const r = resolveHandoffMessage({ settings: { ...settings, hours: { ...WEEKDAYS_9_TO_6, tue: { open: true, start: '10:00', end: '18:00' } } }, reason: 'model', now: kl('2026-10-26T19:00:00') })
    expect(r.which).toBe('closed')
    expect(r.text).toBe('We are closed. We will reply tomorrow at 10am.')
  })
  it('says today when it opens later today', () => {
    const r = resolveHandoffMessage({ settings, reason: 'model', now: kl('2026-10-26T07:00:00') })
    expect(r.text).toBe('We are closed. We will reply today at 9am.')
  })
  it('says "on Monday" over the weekend', () => {
    const r = resolveHandoffMessage({ settings, reason: 'model', now: kl('2026-10-24T12:00:00') })
    expect(r.text).toBe('We are closed. We will reply on Monday at 9am.')
  })
  it('uses the open message when open, with hours today', () => {
    const r = resolveHandoffMessage({ settings, reason: 'model', now: kl('2026-10-26T10:00:00') })
    expect(r).toMatchObject({ which: 'open', open: true, hoursMissing: false, send: true })
    expect(r.text).toBe('Connecting you to a teammate. We are open 9am–6pm.')
  })
  it('uses the open message and flags it when hours are not set', () => {
    const r = resolveHandoffMessage({ settings: { ...settings, hours: null }, reason: 'model', now: kl('2026-10-25T03:00:00') })
    expect(r).toMatchObject({ which: 'open', hoursMissing: true })
  })
  it('uses the reply-cap message for reason cap, open or closed', () => {
    const open = resolveHandoffMessage({ settings, reason: 'cap', now: kl('2026-10-26T10:00:00') })
    const closed = resolveHandoffMessage({ settings, reason: 'cap', now: kl('2026-10-25T10:00:00') })
    expect(open).toMatchObject({ which: 'cap', send: true, text: 'We will take it from here. Hours today: 9am–6pm.' })
    expect(closed.which).toBe('cap')
    expect(closed.text).toBe('We will take it from here. Hours today: closed today.')
  })
  it('does not send when disabled or when the chosen message is blank', () => {
    expect(resolveHandoffMessage({ settings: { ...settings, enabled: false }, reason: 'model', now: kl('2026-10-26T10:00:00') }).send).toBe(false)
    expect(resolveHandoffMessage({ settings: { ...settings, openMessage: '  ' }, reason: 'model', now: kl('2026-10-26T10:00:00') }).send).toBe(false)
  })
  it('reads naturally when no day is open at all', () => {
    const r = resolveHandoffMessage({ settings: { ...settings, hours: ALL_CLOSED }, reason: 'model', now: kl('2026-10-26T10:00:00') })
    expect(r.text).toBe('We are closed. We will reply soon.')
  })
  it('accepts spaces inside the braces and leaves unknown placeholders alone', () => {
    expect(
      renderHandoffMessage('{{ next_open_day }} {{unknown}}', { nextOpenDay: 'today', nextOpenTime: '9am', hoursToday: 'x' }),
    ).toBe('today {{unknown}}')
  })
})

describe('validateWeeklyHours / parseStoredHours', () => {
  it('accepts the defaults and normalises', () => {
    const v = validateWeeklyHours(DEFAULT_WEEKLY_HOURS)
    expect(v.ok).toBe(true)
  })
  it('rejects an end before the start, and an end equal to the start', () => {
    const bad = { ...DEFAULT_WEEKLY_HOURS, wed: { open: true, start: '18:00', end: '09:00' } }
    expect(validateWeeklyHours(bad)).toEqual({ ok: false, day: 'wed', reason: 'order' })
    const same = { ...DEFAULT_WEEKLY_HOURS, wed: { open: true, start: '09:00', end: '09:00' } }
    expect(validateWeeklyHours(same)).toMatchObject({ ok: false, reason: 'order' })
  })
  it('rejects overnight ranges (they look like end before start)', () => {
    const overnight = { ...DEFAULT_WEEKLY_HOURS, fri: { open: true, start: '22:00', end: '02:00' } }
    expect(validateWeeklyHours(overnight)).toMatchObject({ ok: false, day: 'fri', reason: 'order' })
  })
  it('rejects malformed times and missing days', () => {
    expect(validateWeeklyHours({ ...DEFAULT_WEEKLY_HOURS, mon: { open: true, start: '9am', end: '18:00' } })).toMatchObject({ ok: false, reason: 'time' })
    expect(validateWeeklyHours({ ...DEFAULT_WEEKLY_HOURS, mon: { open: true, start: '09:00', end: '24:00' } })).toMatchObject({ ok: false, reason: 'time' })
    const missing: Partial<WeeklyHours> = { ...DEFAULT_WEEKLY_HOURS }
    delete missing.sun
    expect(validateWeeklyHours(missing)).toEqual({ ok: false, day: 'sun', reason: 'shape' })
    expect(validateWeeklyHours(null)).toMatchObject({ ok: false, reason: 'shape' })
  })
  it('does not validate times on closed days, but keeps usable ones', () => {
    const v = validateWeeklyHours({ ...DEFAULT_WEEKLY_HOURS, sat: { open: false, start: 'oops', end: '' } })
    expect(v.ok && v.hours.sat).toEqual({ open: false, start: '09:00', end: '18:00' })
  })
  it('treats unusable stored values as not set', () => {
    expect(parseStoredHours(null)).toBeNull()
    expect(parseStoredHours({ mon: 1 })).toBeNull()
    expect(parseStoredHours(DEFAULT_WEEKLY_HOURS)).toEqual(DEFAULT_WEEKLY_HOURS)
  })
  it('parses clock strings', () => {
    expect(clockToMinutes('00:00')).toBe(0)
    expect(clockToMinutes('23:59')).toBe(1439)
    expect(clockToMinutes('24:00')).toBeNull()
    expect(clockToMinutes('9:00')).toBeNull()
  })
})

describe('wallTimeToDate (preview test time)', () => {
  it('reads a wall clock time in the chosen zone', () => {
    expect(wallTimeToDate('2026-10-26T09:00', KL)?.toISOString()).toBe('2026-10-26T01:00:00.000Z')
    expect(wallTimeToDate('2026-10-26T09:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-10-26T03:30:00.000Z')
  })
  it('follows daylight saving', () => {
    expect(wallTimeToDate('2026-07-06T09:00', 'America/New_York')?.toISOString()).toBe('2026-07-06T13:00:00.000Z')
    expect(wallTimeToDate('2026-12-07T09:00', 'America/New_York')?.toISOString()).toBe('2026-12-07T14:00:00.000Z')
  })
  it('round-trips with isOpen at the opening minute', () => {
    const open = wallTimeToDate('2026-10-26T09:00', KL)!
    const before = wallTimeToDate('2026-10-26T08:59', KL)!
    expect(isOpen(open, KL, WEEKDAYS_9_TO_6)).toBe(true)
    expect(isOpen(before, KL, WEEKDAYS_9_TO_6)).toBe(false)
  })
  it('rejects malformed input', () => {
    expect(wallTimeToDate('', KL)).toBeNull()
    expect(wallTimeToDate('2026-10-26 09:00', KL)).toBeNull()
  })
})
