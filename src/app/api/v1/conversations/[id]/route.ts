// ============================================================
// GET   /api/v1/conversations/{id} — read one conversation (conversations:read)
// PATCH /api/v1/conversations/{id} — status / assignment / AI pause / mark read
//                                    (conversations:write); see the PATCH below.
// Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';
import { handler } from '@/lib/api/v1/route';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { assertOwned } from '@/lib/api/v1/resources';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

// ============================================================
// PATCH /api/v1/conversations/{id}  (scope conversations:write)
//
// Run the inbox from outside it. Body (all optional):
//   status            "open" | "pending" | "closed"
//   assigned_agent_id member user id to assign, or null to unassign
//                     (assigning notifies that member, like the dashboard)
//   ai_paused         true  = pause the AI bot on this thread (a human takes over)
//                     false = hand the thread back to the bot: this also
//                             releases any assignment (unless assigned_agent_id
//                             is sent in the same call), resets the bot's reply
//                             count and clears the handoff note
//   mark_read         true  = clear the unread counter
// ============================================================


export const PATCH = handler<{ id: string }>('conversations:write', async (ctx, request, { id }) => {
  if (!isUuidString(id)) return fail('not_found', 'Conversation not found', 404);
  const body = parseBody(
    await readBody(request),
    {
      status: { type: 'enum', values: ['open', 'pending', 'closed'] },
      assigned_agent_id: { type: 'uuid', nullable: true },
      ai_paused: { type: 'bool' },
      mark_read: { type: 'bool' },
    },
    { partial: true }
  );

  const { data: existing } = await ctx.supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!existing) return fail('not_found', 'Conversation not found', 404);

  if (typeof body.assigned_agent_id === 'string') {
    await assertOwned(ctx, 'profiles', [body.assigned_agent_id], 'Team member', 'user_id');
  }

  const update: Record<string, unknown> = {};
  if ('status' in body) update.status = body.status;
  if ('assigned_agent_id' in body) update.assigned_agent_id = body.assigned_agent_id;
  if (body.mark_read === true) update.unread_count = 0;
  if (body.ai_paused === true) {
    update.ai_autoreply_disabled = true;
  } else if (body.ai_paused === false) {
    update.ai_autoreply_disabled = false;
    update.ai_reply_count = 0;
    update.ai_handoff_summary = null;
    // A human assignee mutes the bot, so handing back must release it
    // (same rule as the inbox's "Resume AI").
    if (!('assigned_agent_id' in body)) update.assigned_agent_id = null;
  }
  if (Object.keys(update).length === 0) {
    return fail('bad_request', 'Nothing to update: send status, assigned_agent_id, ai_paused or mark_read=true', 400);
  }

  const { data, error } = await ctx.supabase
    .from('conversations')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(CONVERSATION_SELECT)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/conversations] update error:', error);
    return fail('internal', 'Failed to update conversation', 500);
  }
  if (!data) return fail('not_found', 'Conversation not found', 404);

  await recordAudit(ctx, {
    action: 'conversation.update',
    resourceType: 'conversation',
    resourceId: id,
    fields: Object.keys(body),
  });
  return ok(serializeConversation(normalizeConversation(data as unknown as Conversation)));
});
