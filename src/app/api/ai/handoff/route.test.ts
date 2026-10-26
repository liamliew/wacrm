import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  members: ['agent-1'] as string[],
  updated: [] as Record<string, unknown>[],
  rowsMatched: [{ account_id: 'acc-1' }] as { account_id: string }[],
  dbError: null as { message: string } | null,
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') {
          const chain = {
            select: () => chain,
            eq: (col: string, val: string) => {
              if (col === 'user_id') (chain as { id?: string }).id = val
              return chain
            },
            maybeSingle: async () => ({
              data: h.members.includes((chain as { id?: string }).id ?? '')
                ? { user_id: (chain as { id?: string }).id }
                : null,
              error: null,
            }),
          }
          return chain
        }
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              select: async () => {
                h.updated.push(patch)
                return { data: h.dbError ? null : h.rowsMatched, error: h.dbError }
              },
            }),
          }),
        }
      },
    },
  }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}))

import { PUT } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    { open: d !== 'sat' && d !== 'sun', start: '09:00', end: '18:00' },
  ]),
)

function put(body: unknown) {
  return PUT(
    new Request('http://t/api/ai/handoff', { method: 'PUT', body: JSON.stringify(body) }),
  ) as unknown as Promise<{ status: number; body: Record<string, unknown> }>
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.members = ['agent-1']
  h.updated = []
  h.rowsMatched = [{ account_id: 'acc-1' }]
  h.dbError = null
})

describe('PUT /api/ai/handoff', () => {
  it('saves the target, zone, hours, switch and the three messages in one update', async () => {
    const res = await put({
      handoff_agent_id: 'agent-1',
      timezone: 'Asia/Kuala_Lumpur',
      hours: HOURS,
      message_enabled: true,
      open_message: '  Hi, a teammate is on it.  ',
      closed_message: 'We reopen {{next_open_day}} at {{next_open_time}}.',
      cap_message: 'Passing you to the team.',
    })
    expect(res.status).toBe(200)
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]).toMatchObject({
      handoff_agent_id: 'agent-1',
      handoff_timezone: 'Asia/Kuala_Lumpur',
      handoff_hours: HOURS,
      handoff_message_enabled: true,
      handoff_open_message: 'Hi, a teammate is on it.',
      handoff_closed_message: 'We reopen {{next_open_day}} at {{next_open_time}}.',
      handoff_cap_message: 'Passing you to the team.',
    })
  })

  it('treats an empty or null target as the unassigned queue, and blank messages as cleared', async () => {
    await put({ handoff_agent_id: '', open_message: '   ', cap_message: null })
    expect(h.updated[0]).toEqual({
      handoff_agent_id: null,
      handoff_open_message: null,
      handoff_cap_message: null,
    })
  })

  it('leaves absent fields alone', async () => {
    await put({ message_enabled: false })
    expect(h.updated[0]).toEqual({ handoff_message_enabled: false })
  })

  it('rejects a target who is not a member of the account', async () => {
    const res = await put({ handoff_agent_id: 'stranger' })
    expect(res.status).toBe(400)
    expect(h.updated).toHaveLength(0)
  })

  it('rejects an unknown time zone', async () => {
    expect((await put({ timezone: 'Mars/Olympus' })).status).toBe(400)
    expect((await put({ timezone: 5 })).status).toBe(400)
    expect(h.updated).toHaveLength(0)
  })

  it('rejects hours whose end is before the start, and malformed hours', async () => {
    const reversed = { ...HOURS, tue: { open: true, start: '18:00', end: '09:00' } }
    expect((await put({ hours: reversed })).status).toBe(400)
    expect((await put({ hours: { mon: {} } })).status).toBe(400)
    expect((await put({ hours: 'always' })).status).toBe(400)
    expect(h.updated).toHaveLength(0)
  })

  it('accepts clearing the hours', async () => {
    expect((await put({ hours: null })).status).toBe(200)
    expect(h.updated[0]).toEqual({ handoff_hours: null })
  })

  it('rejects a message over the limit and non-string messages', async () => {
    expect((await put({ open_message: 'x'.repeat(1001) })).status).toBe(400)
    expect((await put({ closed_message: 12 })).status).toBe(400)
    expect((await put({ open_message: 'x'.repeat(1000) })).status).toBe(200)
  })

  it('rejects a non-boolean switch and an empty or invalid body', async () => {
    expect((await put({ message_enabled: 'yes' })).status).toBe(400)
    expect((await put({})).status).toBe(400)
    expect((await put(null)).status).toBe(400)
    expect((await put([1])).status).toBe(400)
  })

  it('answers 409 when the AI provider is not set up yet', async () => {
    h.rowsMatched = []
    expect((await put({ message_enabled: true })).status).toBe(409)
  })

  it('answers 500 on a database error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.dbError = { message: 'boom' }
    expect((await put({ message_enabled: true })).status).toBe(500)
    err.mockRestore()
  })
})
