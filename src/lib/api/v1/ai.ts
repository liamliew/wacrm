// ============================================================
// Shared pieces for the /api/v1/ai/* routes.
// ============================================================

import { AiError } from '@/lib/ai/types';
import type { IngestResult } from '@/lib/ai/knowledge';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');

/**
 * What a caller may read of the AI agent config. The provider API key
 * and embeddings key are selected only to derive the has_* flags; they
 * are never serialized.
 */
export const AI_CONFIG_SELECT =
  'provider, model, base_url, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, handoff_timezone, handoff_hours, handoff_message_enabled, handoff_open_message, handoff_closed_message, handoff_cap_message, api_key, embeddings_api_key, updated_at';

export function serializeAiConfig(row: Record<string, unknown>) {
  return {
    provider: row.provider,
    model: row.model,
    base_url: row.base_url ?? null,
    system_prompt: row.system_prompt ?? null,
    is_active: row.is_active === true,
    auto_reply_enabled: row.auto_reply_enabled === true,
    auto_reply_max_per_conversation: row.auto_reply_max_per_conversation,
    // Handoff settings use the same names the PATCH body accepts.
    handoff_agent_id: row.handoff_agent_id ?? null,
    timezone: row.handoff_timezone ?? null,
    hours: row.handoff_hours ?? null,
    message_enabled: row.handoff_message_enabled === true,
    open_message: row.handoff_open_message ?? null,
    closed_message: row.handoff_closed_message ?? null,
    cap_message: row.handoff_cap_message ?? null,
    has_provider_key: !!row.api_key,
    has_embeddings_key: !!row.embeddings_api_key,
    updated_at: row.updated_at ?? null,
  };
}

/** Turn how a knowledge-document ingest went into an optional warning. */
export function ingestWarning(
  outcome: { ingest?: IngestResult; threw?: unknown; keyCorrupt?: boolean },
): { warning?: string; keyword_only?: boolean } {
  if (outcome.threw !== undefined) {
    const message =
      outcome.threw instanceof AiError ? outcome.threw.message : t('ai.knowledge.indexingFailed');
    return { warning: `Saved, but indexing failed (${message}). Use reindex to retry.` };
  }
  if (outcome.ingest?.keywordOnly) {
    const message =
      outcome.ingest.embedError instanceof AiError
        ? outcome.ingest.embedError.message
        : t('ai.knowledge.indexingFailed');
    return {
      keyword_only: true,
      warning: `Saved with keyword search only (embedding failed: ${message}).`,
    };
  }
  if (outcome.keyCorrupt) {
    return {
      keyword_only: true,
      warning:
        'Saved with keyword search only: the embeddings key could not be decrypted. Re-enter it in the dashboard.',
    };
  }
  return {};
}
