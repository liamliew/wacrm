// ============================================================
// POST /api/v1/ai/playground  (scope ai:read)
//
// Chat with the agent without touching WhatsApp: the same path the
// auto-reply bot uses (knowledge retrieval + prompt + provider), so you
// see what a customer would get. Stateless: send the transcript.
//
//   { messages: [{ role: 'user'|'assistant', content }], system_prompt? }
//
// `system_prompt` tries a CANDIDATE prompt for this call only; nothing
// is saved. That is the safe way to iterate before PATCHing /ai/config.
// Costs tokens on the account's AI key, so it has its own per-key limit.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest, rateLimited } from '@/lib/api/v1/respond';
import { readBody } from '@/lib/api/v1/input';
import { loadAiConfig } from '@/lib/ai/config';
import { retrieveKnowledge } from '@/lib/ai/knowledge';
import { generateReply } from '@/lib/ai/generate';
import { buildSystemPrompt } from '@/lib/ai/defaults';
import { latestUserMessage } from '@/lib/ai/query';
import { AiError, type ChatMessage } from '@/lib/ai/types';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

const MAX_TURNS = 20;

export const POST = handler('ai:read', async (ctx, request) => {
  const limit = checkRateLimit(`apikey-ai:${ctx.keyId}`, RATE_LIMITS.aiDraft);
  if (!limit.success) throw rateLimited(limit);

  const body = await readBody(request);
  for (const k of Object.keys(body)) {
    if (k !== 'messages' && k !== 'system_prompt') throw badRequest(`Unknown field '${k}'. Allowed: messages, system_prompt`);
  }
  if (!Array.isArray(body.messages)) throw badRequest("'messages' must be an array");
  const messages: ChatMessage[] = (body.messages as unknown[])
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === 'object' &&
        ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
        typeof (m as ChatMessage).content === 'string' &&
        (m as ChatMessage).content.trim().length > 0
    )
    .slice(-MAX_TURNS);
  if (messages.length === 0) throw badRequest('Send at least one non-empty user message');
  if (body.system_prompt !== undefined && typeof body.system_prompt !== 'string') {
    throw badRequest("'system_prompt' must be a string");
  }
  if (typeof body.system_prompt === 'string' && body.system_prompt.length > 20_000) {
    throw badRequest("'system_prompt' must be at most 20000 characters");
  }

  try {
    const config = await loadAiConfig(ctx.supabase, ctx.accountId, { requireActive: false });
    if (!config) return fail('conflict', 'No agent configured yet. Set up the AI provider in the dashboard.', 409);

    const userPrompt =
      typeof body.system_prompt === 'string' ? body.system_prompt : config.systemPrompt;
    const knowledge = await retrieveKnowledge(ctx.supabase, ctx.accountId, config, latestUserMessage(messages));
    const systemPrompt = buildSystemPrompt({ userPrompt, mode: 'auto_reply', knowledge });
    const { text, handoff } = await generateReply({ config, systemPrompt, messages });
    return ok({
      reply: text,
      would_hand_off: handoff,
      used_prompt_override: typeof body.system_prompt === 'string',
      knowledge_excerpts_used: knowledge.length,
    });
  } catch (err) {
    if (err instanceof AiError) return fail(err.code ?? 'bad_request', err.message, err.status >= 400 && err.status < 500 ? 400 : 502);
    throw err;
  }
});
