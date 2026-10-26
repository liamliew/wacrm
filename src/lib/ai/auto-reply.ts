import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { resolveHandoffMessage, type HandoffReason } from './handoff-hours'
import { loadHandoffSettings } from './handoff-settings'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Reply cap reached: the bot stops here, so hand the thread to a human
    // (and tell the customer, if configured) instead of leaving it silent.
    // The authoritative cap check is still the atomic claim below (this
    // read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      await handOffConversation({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        handoffAgentId: config.handoffAgentId,
        messages: await buildConversationContext(db, conversationId),
        replyCount: conv.ai_reply_count ?? 0,
        reason: 'cap',
      })
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human; see `handOffConversation`.
      await handOffConversation({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        handoffAgentId: config.handoffAgentId,
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        reason: 'model',
      })
      return
    }

    if (
      inboundMessageId &&
      (await hasNewerInbound(db, conversationId, inboundMessageId))
    ) {
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

interface HandOffArgs {
  db: ReturnType<typeof supabaseAdmin>
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  handoffAgentId: string | null
  messages: Awaited<ReturnType<typeof buildConversationContext>>
  replyCount: number
  reason: HandoffReason
}

/**
 * Hand a conversation to a human: (a) pause the bot here (sticky until
 * re-enabled), (b) route the conversation to the configured handoff
 * agent — null leaves it in the shared queue — and (c) leave a short
 * internal note so whoever picks it up has context. Assigning fires the
 * `on_conversation_assigned` trigger, which notifies the agent. Then, if
 * the account configured one, tell the customer.
 *
 * The update only matches while the bot is still active on the thread, so
 * of two racing dispatches exactly one performs the handoff (and sends
 * the message). "Resume AI" re-enables the bot, so a later handoff on the
 * same thread is a new handoff and may message again.
 */
async function handOffConversation(args: HandOffArgs): Promise<void> {
  const { db, conversationId, reason } = args

  const summary = buildHandoffSummary({
    messages: args.messages,
    replyCount: args.replyCount,
    reason,
  })
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  // Only set the assignee when a target is configured AND the thread
  // isn't already owned — never stomp an existing human assignment. (The
  // eligibility gate already returned for assigned threads, so the
  // `assigned_agent_id is null` filter below is what enforces it on a race.)
  if (args.handoffAgentId) update.assigned_agent_id = args.handoffAgentId

  let query = db
    .from('conversations')
    .update(update)
    .eq('id', conversationId)
    .eq('ai_autoreply_disabled', false)
  if (args.handoffAgentId) query = query.is('assigned_agent_id', null)
  const { data: flipped, error } = await query.select('id')
  if (error) {
    console.error('[ai auto-reply] handoff update failed:', error)
    return
  }
  if (!flipped || flipped.length === 0) return // already handed off by another dispatch

  await sendHandoffMessage(args)
}

/**
 * Best-effort message to the customer after a handoff. Never throws: a
 * failed send (Meta error, no WhatsApp config, settings not readable) is
 * logged and the handoff stands.
 */
async function sendHandoffMessage(args: HandOffArgs): Promise<void> {
  try {
    const settings = await loadHandoffSettings(args.db, args.accountId)
    if (!settings) return
    const chosen = resolveHandoffMessage({
      settings,
      reason: args.reason,
      now: new Date(),
    })
    if (!chosen.send) return
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: chosen.text,
    })
  } catch (err) {
    console.error(
      `[ai auto-reply] handoff message failed for conversation ${args.conversationId} (the handoff itself stands):`,
      err,
    )
  }
}

async function hasNewerInbound(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return false
  return data[0].message_id !== inboundMessageId
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
