// ============================================================
// Generic account-scoped CRUD for simple /api/v1 resources.
//
// Tags, custom fields, quick replies, pipelines and the like all follow
// one pattern: rows belong to an account, are listed newest-first with
// keyset paging, and are created / edited / deleted with a validated
// body. `collection(cfg)` and `item(cfg)` turn a small config into the
// route handlers, so the security-relevant parts (key + scope check,
// account scoping on EVERY query, strict body validation, audit row)
// live in one place and are tested once.
//
//   // src/app/api/v1/tags/route.ts
//   export const { GET, POST } = collection(TAGS);
//   // src/app/api/v1/tags/[id]/route.ts
//   export const { GET, PATCH, DELETE } = item(TAGS);
// ============================================================

import type { ApiKeyContext } from '@/lib/auth/api-context';
import type { ApiScope } from '@/lib/api-keys/scopes';
import { handler } from '@/lib/api/v1/route';
import { ok, okList, fail, badRequest } from '@/lib/api/v1/respond';
import { parseBody, readBody, isUuidString, type Schema } from '@/lib/api/v1/input';
import { buildPage, keysetFilter, parseListParams } from '@/lib/api/v1/pagination';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

type Row = Record<string, unknown>;

export interface ResourceConfig {
  /** Singular noun for messages and audit rows, e.g. "tag". */
  resource: string;
  table: string;
  /** Columns returned to the caller. Never include account_id / user_id. */
  select: string;
  readScope: ApiScope;
  writeScope: ApiScope;
  /** Defaults to writeScope. */
  deleteScope?: ApiScope;
  /** Body fields; each name is also the column it writes. */
  schema: Schema;
  /** Query-string filters on list: name → how to validate (column = name). */
  filters?: Record<string, 'uuid' | 'string' | { enum: readonly string[] }>;
  /** Column that records the acting user on insert (the account's owner stands in). */
  auditUserColumn?: 'user_id' | 'created_by';
  /** Extra checks (e.g. referenced ids belong to this account). Throw ApiError to refuse. */
  validate?: (
    ctx: ApiKeyContext,
    data: Row,
    mode: 'create' | 'update',
    existing: Row | null
  ) => Promise<void>;
  /**
   * Adjust the validated data before it is written (e.g. null out the
   * field that does not apply to the chosen `kind`). `existing` is the
   * stored row on update.
   */
  normalize?: (data: Row, mode: 'create' | 'update', existing: Row | null) => Row;
  /** Extra columns set on insert, computed from the validated data. */
  onInsert?: (ctx: ApiKeyContext, data: Row) => Promise<Row> | Row;
  noCreate?: boolean;
  noDelete?: boolean;
}

function dbFailure(cfg: ResourceConfig, error: { code?: string; message?: string }, verb: string) {
  if (error.code === '23505') {
    return fail('conflict', `A ${cfg.resource} with those details already exists`, 409);
  }
  if (error.code === '23503') {
    return fail('conflict', `This ${cfg.resource} is still in use, or refers to something that does not exist`, 409);
  }
  console.error(`[api/v1/${cfg.table}] ${verb} error:`, error);
  return fail('internal', `Failed to ${verb} ${cfg.resource}`, 500);
}

async function findOne(ctx: ApiKeyContext, cfg: ResourceConfig, id: string): Promise<Row | null> {
  const { data, error } = await ctx.supabase
    .from(cfg.table)
    .select(cfg.select)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new Error(`${cfg.table} read failed: ${error.message}`);
  return (data as Row | null) ?? null;
}

function requireId(id: string, cfg: ResourceConfig) {
  if (!isUuidString(id)) throw badRequest(`${cfg.resource} id must be a UUID`);
}

export function collection(cfg: ResourceConfig) {
  const GET = handler(cfg.readScope, async (ctx, request) => {
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    let query = ctx.supabase
      .from(cfg.table)
      .select(cfg.select)
      .eq('account_id', ctx.accountId);

    for (const [name, kind] of Object.entries(cfg.filters ?? {})) {
      const value = url.searchParams.get(name);
      if (value === null || value === '') continue;
      if (kind === 'uuid' && !isUuidString(value)) throw badRequest(`'${name}' must be an id (UUID)`);
      if (typeof kind === 'object' && !kind.enum.includes(value)) {
        throw badRequest(`'${name}' must be one of: ${kind.enum.join(', ')}`);
      }
      query = query.eq(name, value);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);
    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) return dbFailure(cfg, error, 'list');
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(items, nextCursor);
  });

  const POST = cfg.noCreate
    ? undefined
    : handler(cfg.writeScope, async (ctx, request) => {
        let data = parseBody(await readBody(request), cfg.schema, { partial: false });
        await cfg.validate?.(ctx, data, 'create', null);
        if (cfg.normalize) data = cfg.normalize(data, 'create', null);

        const extra = cfg.onInsert ? await cfg.onInsert(ctx, data) : {};
        const row: Row = { ...data, ...extra, account_id: ctx.accountId };
        if (cfg.auditUserColumn) {
          row[cfg.auditUserColumn] = await resolveAuditUserId(ctx.supabase, ctx.accountId);
        }

        const { data: created, error } = await ctx.supabase
          .from(cfg.table)
          .insert(row)
          .select(cfg.select)
          .single();
        if (error || !created) return dbFailure(cfg, error ?? {}, 'create');

        await recordAudit(ctx, {
          action: `${cfg.resource}.create`,
          resourceType: cfg.resource,
          resourceId: String((created as unknown as Row).id),
          fields: Object.keys(data),
        });
        return ok(created, 201);
      });

  return { GET, ...(POST ? { POST } : {}) } as {
    GET: typeof GET;
    POST: typeof GET;
  };
}

export function item(cfg: ResourceConfig) {
  const GET = handler<{ id: string }>(cfg.readScope, async (ctx, _request, { id }) => {
    requireId(id, cfg);
    const row = await findOne(ctx, cfg, id);
    if (!row) return fail('not_found', `${cap(cfg.resource)} not found`, 404);
    return ok(row);
  });

  const PATCH = handler<{ id: string }>(cfg.writeScope, async (ctx, request, { id }) => {
    requireId(id, cfg);
    let data = parseBody(await readBody(request), cfg.schema, { partial: true });
    const existing = await findOne(ctx, cfg, id);
    if (!existing) return fail('not_found', `${cap(cfg.resource)} not found`, 404);
    await cfg.validate?.(ctx, data, 'update', existing);
    if (cfg.normalize) data = cfg.normalize(data, 'update', existing);

    const { data: updated, error } = await ctx.supabase
      .from(cfg.table)
      .update(data)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(cfg.select)
      .maybeSingle();
    if (error) return dbFailure(cfg, error, 'update');
    if (!updated) return fail('not_found', `${cap(cfg.resource)} not found`, 404);

    await recordAudit(ctx, {
      action: `${cfg.resource}.update`,
      resourceType: cfg.resource,
      resourceId: id,
      fields: Object.keys(data),
    });
    return ok(updated);
  });

  const DELETE = cfg.noDelete
    ? undefined
    : handler<{ id: string }>(cfg.deleteScope ?? cfg.writeScope, async (ctx, _request, { id }) => {
        requireId(id, cfg);
        const existing = await findOne(ctx, cfg, id);
        if (!existing) return fail('not_found', `${cap(cfg.resource)} not found`, 404);

        const { error } = await ctx.supabase
          .from(cfg.table)
          .delete()
          .eq('id', id)
          .eq('account_id', ctx.accountId);
        if (error) return dbFailure(cfg, error, 'delete');

        await recordAudit(ctx, {
          action: `${cfg.resource}.delete`,
          resourceType: cfg.resource,
          resourceId: id,
        });
        return ok({ id, deleted: true });
      });

  return { GET, PATCH, ...(DELETE ? { DELETE } : {}) } as {
    GET: typeof GET;
    PATCH: typeof GET;
    DELETE: typeof GET;
  };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
