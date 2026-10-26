// ============================================================
// GET   /api/v1/ai/config  — read the AI agent setup      (scope ai:read)
// PATCH /api/v1/ai/config  — change how the agent behaves (scope ai:write)
//
// PATCH body (all optional, absent = unchanged):
//   system_prompt                    business context / instructions (null clears)
//   is_active, auto_reply_enabled    master switch / auto-reply switch
//   auto_reply_max_per_conversation  1-20
//   model                            validated against the provider with the stored key
//   handoff_agent_id, timezone, hours, message_enabled,
//   open_message, closed_message, cap_message   the Handoff tab
//
// Deliberately NOT here: the provider, base URL and API keys. Changing
// where prompts and customer data are sent, or what key is used, stays
// a dashboard action.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { parseBody, readBody, type Schema } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { AI_CONFIG_SELECT, serializeAiConfig } from '@/lib/api/v1/ai';
import { HANDOFF_BODY_FIELDS, parseHandoffUpdate } from '@/lib/ai/handoff-update';
import { validateAiCredentials } from '@/lib/ai/validate';
import { AiError, type AiProvider } from '@/lib/ai/types';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');

const SCHEMA: Schema = {
  system_prompt: { type: 'text', max: 20_000, nullable: true },
  is_active: { type: 'bool' },
  auto_reply_enabled: { type: 'bool' },
  auto_reply_max_per_conversation: { type: 'int', min: 1, max: 20 },
  model: { type: 'string', min: 1, max: 120 },
};

export const GET = handler('ai:read', async (ctx) => {
  const { data, error } = await ctx.supabase
    .from('ai_configs')
    .select(AI_CONFIG_SELECT)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/ai/config] read error:', error);
    return fail('internal', 'Failed to read AI configuration', 500);
  }
  if (!data) return ok({ configured: false });
  return ok({ configured: true, ...serializeAiConfig(data as unknown as Record<string, unknown>) });
});

export const PATCH = handler('ai:write', async (ctx, request) => {
  const body = await readBody(request);

  const handoffBody: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    ((HANDOFF_BODY_FIELDS as readonly string[]).includes(k) ? handoffBody : rest)[k] = v;
  }

  const base = Object.keys(rest).length ? parseBody(rest, SCHEMA, { partial: true }) : {};
  const handoff = await parseHandoffUpdate(handoffBody, {
    isMember: async (userId) => {
      const { data } = await ctx.supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .maybeSingle();
      return !!data;
    },
  });
  if (!handoff.ok) throw badRequest(t(`ai.${handoff.error.key}`, handoff.error.params));

  const update = { ...base, ...handoff.update };
  if (Object.keys(update).length === 0) {
    throw badRequest('Nothing to update: send at least one field');
  }

  const { data: existing, error: readErr } = await ctx.supabase
    .from('ai_configs')
    .select('provider, model, base_url, api_key')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (readErr) return fail('internal', 'Failed to read AI configuration', 500);
  if (!existing) {
    return fail('conflict', 'The AI provider is not set up yet. Add the provider and key in the dashboard first.', 409);
  }

  // A new model is checked against the provider with the stored key,
  // like the dashboard does, so a typo cannot silently break replies.
  if (typeof update.model === 'string' && update.model !== existing.model) {
    let apiKey: string;
    try {
      apiKey = decrypt(existing.api_key as string);
    } catch {
      return fail('bad_request', t('ai.storedKeyReenter'), 400);
    }
    try {
      await validateAiCredentials({
        provider: existing.provider as AiProvider,
        model: update.model,
        baseUrl: (existing.base_url as string | null) ?? null,
        apiKey,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 1,
        handoffAgentId: null,
        embeddingsApiKey: null,
      });
    } catch (err) {
      if (err instanceof AiError) {
        return fail(err.code ?? 'bad_request', `The provider rejected model "${update.model}": ${err.message}`, 400);
      }
      console.error('[api/v1/ai/config] model validation error:', err);
      return fail('bad_request', 'Could not validate the model with the provider.', 400);
    }
  }

  const { data: saved, error } = await ctx.supabase
    .from('ai_configs')
    .update(update)
    .eq('account_id', ctx.accountId)
    .select(AI_CONFIG_SELECT)
    .maybeSingle();
  if (error || !saved) {
    console.error('[api/v1/ai/config] update error:', error);
    return fail('internal', 'Failed to save AI configuration', 500);
  }

  await recordAudit(ctx, {
    action: 'ai.config.update',
    resourceType: 'ai_config',
    fields: Object.keys(update),
  });
  return ok({ configured: true, ...serializeAiConfig(saved as unknown as Record<string, unknown>) });
});
