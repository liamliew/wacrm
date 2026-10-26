// ============================================================
// GET  /api/v1/ai/knowledge — list documents (no content)   (knowledge:read)
// POST /api/v1/ai/knowledge — add a document and index it   (knowledge:write)
//   body: { title, content }
//
// Documents feed the agent's answers (retrieved by relevance), so an
// edit here changes what customers are told. Saved and indexed the same
// way as the dashboard; if indexing hits a problem the document is still
// saved and the response carries a `warning`.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, okList, fail } from '@/lib/api/v1/respond';
import { parseBody, readBody } from '@/lib/api/v1/input';
import { buildPage, keysetFilter, parseListParams } from '@/lib/api/v1/pagination';
import { recordAudit } from '@/lib/api/v1/audit';
import { ingestWarning } from '@/lib/api/v1/ai';
import { KNOWLEDGE_SCHEMA } from '@/lib/api/v1/knowledge-schema';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument, type IngestResult } from '@/lib/ai/knowledge';

export const GET = handler('knowledge:read', async (ctx, request) => {
  const { limit, cursor } = parseListParams(request);
  let query = ctx.supabase
    .from('ai_knowledge_documents')
    .select('id, title, created_at, updated_at')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  const kf = keysetFilter(cursor);
  if (kf) query = query.or(kf);

  const { data, error } = await query;
  if (error) {
    console.error('[api/v1/ai/knowledge] list error:', error);
    return fail('internal', 'Failed to list documents', 500);
  }
  const { items, nextCursor } = buildPage(
    (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
    limit
  );
  return okList(items, nextCursor);
});

export const POST = handler('knowledge:write', async (ctx, request) => {
  const data = parseBody(await readBody(request), KNOWLEDGE_SCHEMA, { partial: false });

  const { data: doc, error } = await ctx.supabase
    .from('ai_knowledge_documents')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.createdBy,
      title: data.title,
      content: data.content,
    })
    .select('id, title, created_at, updated_at')
    .single();
  if (error || !doc) {
    console.error('[api/v1/ai/knowledge] insert error:', error);
    return fail('internal', 'Failed to save document', 500);
  }
  const id = (doc as unknown as { id: string }).id;

  const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(ctx.supabase, ctx.accountId);
  let ingest: IngestResult | undefined;
  let threw: unknown;
  try {
    ingest = await ingestDocument(ctx.supabase, ctx.accountId, { embeddingsApiKey }, id, data.content as string);
  } catch (err) {
    console.error('[api/v1/ai/knowledge] ingest error:', err);
    threw = err;
  }

  await recordAudit(ctx, {
    action: 'knowledge.create',
    resourceType: 'knowledge_document',
    resourceId: id,
    fields: ['title', 'content'],
    detail: { characters: (data.content as string).length },
  });
  return ok({ ...(doc as object), ...ingestWarning({ ingest, threw, keyCorrupt: corrupt }) }, 201);
});
