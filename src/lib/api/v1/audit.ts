// ============================================================
// Audit trail for state-changing /api/v1 calls (migration 061).
//
// Records WHO (the key) did WHAT (action + resource) and which fields
// were touched — never the values. Best-effort by design: a failure to
// write the audit row is logged but never fails or undoes the change
// the caller asked for.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditEntry {
  /** Dotted action, e.g. "ai.config.update". */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** Names of the fields that were written (never their values). */
  fields?: string[];
  /** Small extra detail that is safe to store (counts, ids, flags). */
  detail?: Record<string, unknown>;
}

export interface AuditActor {
  supabase: SupabaseClient;
  accountId: string;
  keyId: string;
}

export async function recordAudit(
  actor: AuditActor,
  entry: AuditEntry
): Promise<void> {
  try {
    const { error } = await actor.supabase.from('api_audit_log').insert({
      account_id: actor.accountId,
      api_key_id: actor.keyId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      summary: { fields: entry.fields ?? [], ...(entry.detail ?? {}) },
    });
    if (error) console.error('[api/v1 audit] insert failed:', error);
  } catch (err) {
    console.error('[api/v1 audit] insert threw:', err);
  }
}
