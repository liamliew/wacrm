import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  loadHandoffSettings: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    latestInbound: [] as { message_id: string }[],
    /** Rows the handoff update reports as changed ([] = lost the race). */
    updateRows: [{ id: 'conv-1' }] as { id: string }[],
    /** Per-call results consumed first (to model a race); then updateRows. */
    updateQueue: [] as { id: string }[][],
    updateError: null as { message: string } | null,
    updateFilters: [] as string[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./handoff-settings', () => ({ loadHandoffSettings: h.loadHandoffSettings }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.latestInbound, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          const chain = {
            eq: (col: string, val: unknown) => {
              h.state.updateFilters.push(`${col}=${String(val)}`)
              return chain
            },
            is: (col: string, val: unknown) => {
              h.state.updateFilters.push(`${col} is ${String(val)}`)
              return chain
            },
            select: () =>
              Promise.resolve({
                data: h.state.updateError
                  ? null
                  : (h.state.updateQueue.shift() ?? h.state.updateRows),
                error: h.state.updateError,
              }),
          }
          return chain
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    baseUrl: null,
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
  h.state.updateRows = [{ id: 'conv-1' }]
  h.state.updateQueue = []
  h.state.updateError = null
  h.state.updateFilters = []
  h.loadHandoffSettings.mockResolvedValue(null)
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the slot claim is refused after a human takeover', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('leaves the reply to the newer run when another inbound arrived', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-2' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies when the triggering inbound is still the latest', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not call the model or send an AI reply once the cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled() // no message configured
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

// ---------------------------------------------------------------
// Handoff message to the customer
// ---------------------------------------------------------------

const KL = 'Asia/Kuala_Lumpur'
const WEEK = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    { open: !['sat', 'sun'].includes(d), start: '09:00', end: '18:00' },
  ]),
) as never

function handoffSettings(over: Record<string, unknown> = {}) {
  return {
    timeZone: KL,
    hours: WEEK,
    enabled: true,
    openMessage: 'OPEN: a teammate will reply shortly.',
    closedMessage: 'CLOSED: back {{next_open_day}} at {{next_open_time}}.',
    capMessage: 'CAP: handing you to the team.',
    ...over,
  }
}

/** Pin "now" to a Kuala Lumpur wall-clock time (2026-10-26 is a Monday). */
function nowIsKl(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${iso}+08:00`))
}

describe('dispatchInboundToAiReply — handoff message', () => {
  beforeEach(() => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.loadHandoffSettings.mockResolvedValue(handoffSettings())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the open message when the team is open, as a plain bot message', async () => {
    nowIsKl('2026-10-26T10:00:00')
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    const sent = h.engineSendText.mock.calls[0][0]
    expect(sent).toMatchObject({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      userId: 'user-1',
      text: 'OPEN: a teammate will reply shortly.',
    })
    expect(sent.aiGenerated).toBeUndefined() // canned text, not an LLM reply
  })

  it('sends the closed message with the next opening when the team is closed', async () => {
    nowIsKl('2026-10-26T19:00:00') // Monday evening
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('CLOSED: back tomorrow at 9am.')
  })

  it('says "on Monday" over the weekend', async () => {
    nowIsKl('2026-10-24T12:00:00') // Saturday
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('CLOSED: back on Monday at 9am.')
  })

  it('uses the open message when hours are not set', async () => {
    nowIsKl('2026-10-25T03:00:00')
    h.loadHandoffSettings.mockResolvedValue(handoffSettings({ hours: null }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('OPEN: a teammate will reply shortly.')
  })

  it('sends nothing when the setting is off or the message is blank', async () => {
    nowIsKl('2026-10-26T10:00:00')
    h.loadHandoffSettings.mockResolvedValue(handoffSettings({ enabled: false }))
    await dispatchInboundToAiReply(ARGS)
    h.loadHandoffSettings.mockResolvedValue(handoffSettings({ openMessage: '' }))
    h.state.updateFilters = []
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('does the handoff first, and keeps it when the send fails', async () => {
    nowIsKl('2026-10-26T10:00:00')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.engineSendText.mockRejectedValue(new Error('Meta API error: 131047'))
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('handoff message failed for conversation conv-1'),
      expect.any(Error),
    )
    err.mockRestore()
  })

  it('keeps the handoff and sends nothing when settings cannot be loaded', async () => {
    nowIsKl('2026-10-26T10:00:00')
    h.loadHandoffSettings.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('never sends when another dispatch already handed the thread off', async () => {
    nowIsKl('2026-10-26T10:00:00')
    h.state.updateRows = [] // the conditional update matched nothing
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.loadHandoffSettings).not.toHaveBeenCalled()
  })

  it('only flips the handoff while the bot is still active on the thread', async () => {
    nowIsKl('2026-10-26T10:00:00')
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updateFilters).toContain('ai_autoreply_disabled=false')
  })

  it('sends exactly one message when two dispatches race for the same handoff', async () => {
    nowIsKl('2026-10-26T10:00:00')
    // The database lets only the first conditional update through.
    h.state.updateQueue = [[{ id: 'conv-1' }], []]
    await Promise.all([dispatchInboundToAiReply(ARGS), dispatchInboundToAiReply(ARGS)])
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not hand off or message when a human already owns the thread', async () => {
    nowIsKl('2026-10-26T10:00:00')
    h.state.conv = { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false, ai_reply_count: 0 }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — reply cap handoff', () => {
  beforeEach(() => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }
    h.loadHandoffSettings.mockResolvedValue(handoffSettings())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands off at the cap with a summary, without calling the model or taking a reply slot', async () => {
    nowIsKl('2026-10-26T10:00:00')
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('reached its limit of 3 replies')
  })

  it('sends the reply-cap message (not the open or closed one), open or closed', async () => {
    nowIsKl('2026-10-26T10:00:00')
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('CAP: handing you to the team.')

    h.engineSendText.mockClear()
    nowIsKl('2026-10-26T22:00:00')
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('CAP: handing you to the team.')
  })

  it('sends only once for the cap, even if the customer keeps writing', async () => {
    nowIsKl('2026-10-26T10:00:00')
    await dispatchInboundToAiReply(ARGS)
    // The handoff paused the bot on the thread, so the next inbound stops at the gate.
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 3 }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still hands off when the cap message is blank or the feature is off', async () => {
    nowIsKl('2026-10-26T10:00:00')
    h.loadHandoffSettings.mockResolvedValue(handoffSettings({ capMessage: '' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})
