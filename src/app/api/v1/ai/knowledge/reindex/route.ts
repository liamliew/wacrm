// POST /api/v1/ai/knowledge/reindex  (knowledge:write)
// Re-chunk and re-embed every document (e.g. after adding an embeddings key).
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { recordAudit } from '@/lib/api/v1/audit';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument } from '@/lib/ai/knowledge';

export const POST = handler('knowledge:write', async (ctx) => {
  const { data: docs, error } = await ctx.supabase
    .from('ai_knowledge_documents')
    .select('id, content')
    .eq('account_id', ctx.accountId);
  if (error) return fail('internal', 'Failed to load documents', 500);

  const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(ctx.supabase, ctx.accountId);
  if (corrupt) {
    return fail('conflict', 'The embeddings key could not be decrypted; re-enter it in the dashboard before reindexing.', 409);
  }

  let reindexed = 0;
  const failed: string[] = [];
  const keywordOnly: string[] = [];
  for (const doc of docs ?? []) {
    try {
      const result = await ingestDocument(ctx.supabase, ctx.accountId, { embeddingsApiKey }, doc.id, doc.content);
      reindexed += 1;
      if (result.keywordOnly) keywordOnly.push(doc.id);
    } catch (err) {
      console.error(`[api/v1/ai/knowledge/reindex] doc ${doc.id} failed:`, err);
      failed.push(doc.id);
    }
  }
  await recordAudit(ctx, {
    action: 'knowledge.reindex',
    resourceType: 'knowledge_document',
    detail: { total: (docs ?? []).length, reindexed, failed: failed.length },
  });
  return ok({ total: (docs ?? []).length, reindexed, failed, keyword_only: keywordOnly });
});
