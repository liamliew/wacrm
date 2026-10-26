// ============================================================
// GET    /api/v1/ai/knowledge/{id} — read a document with its content (knowledge:read)
// PATCH  /api/v1/ai/knowledge/{id} — edit title and/or content, reindexing (knowledge:write)
// DELETE /api/v1/ai/knowledge/{id} — delete it and its index          (knowledge:write)
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { ingestWarning } from '@/lib/api/v1/ai';
import { KNOWLEDGE_SCHEMA } from '@/lib/api/v1/knowledge-schema';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument, type IngestResult } from '@/lib/ai/knowledge';

const FULL = 'id, title, content, created_at, updated_at';
const notFound = () => fail('not_found', 'Document not found', 404);

export const GET = handler<{ id: string }>('knowledge:read', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return notFound();
  const { data, error } = await ctx.supabase
    .from('ai_knowledge_documents')
    .select(FULL)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) return fail('internal', 'Failed to read document', 500);
  return data ? ok(data) : notFound();
});

export const PATCH = handler<{ id: string }>('knowledge:write', async (ctx, request, { id }) => {
  if (!isUuidString(id)) return notFound();
  const data = parseBody(await readBody(request), KNOWLEDGE_SCHEMA, { partial: true });

  const { data: updated, error } = await ctx.supabase
    .from('ai_knowledge_documents')
    .update(data)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(FULL)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/ai/knowledge] update error:', error);
    return fail('internal', 'Failed to update document', 500);
  }
  if (!updated) return notFound();

  let warning: ReturnType<typeof ingestWarning> = {};
  if (typeof data.content === 'string') {
    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(ctx.supabase, ctx.accountId);
    let ingest: IngestResult | undefined;
    let threw: unknown;
    try {
      ingest = await ingestDocument(ctx.supabase, ctx.accountId, { embeddingsApiKey }, id, data.content);
    } catch (err) {
      console.error('[api/v1/ai/knowledge] ingest error:', err);
      threw = err;
    }
    warning = ingestWarning({ ingest, threw, keyCorrupt: corrupt });
  }

  await recordAudit(ctx, {
    action: 'knowledge.update',
    resourceType: 'knowledge_document',
    resourceId: id,
    fields: Object.keys(data),
  });
  return ok({ ...(updated as object), ...warning });
});

export const DELETE = handler<{ id: string }>('knowledge:write', async (ctx, _req, { id }) => {
  if (!isUuidString(id)) return notFound();
  const { data, error } = await ctx.supabase
    .from('ai_knowledge_documents')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id');
  if (error) return fail('internal', 'Failed to delete document', 500);
  if (!data || data.length === 0) return notFound();
  await recordAudit(ctx, { action: 'knowledge.delete', resourceType: 'knowledge_document', resourceId: id });
  return ok({ id, deleted: true });
});
