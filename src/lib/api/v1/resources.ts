// ============================================================
// Resource definitions for the generic CRUD routes (see crud.ts).
//
// Each entry is the whole contract for one resource: which columns are
// public, which fields a caller may write and how they are validated,
// which scopes guard it, and any cross-row checks. Column names are
// verified against the migrations by resources.test.ts.
// ============================================================

import type { ApiKeyContext } from '@/lib/auth/api-context';
import type { ResourceConfig } from '@/lib/api/v1/crud';
import { ApiError, badRequest } from '@/lib/api/v1/respond';
import { FLOW_STATUSES, FLOW_TRIGGER_TYPES, AUTOMATION_TRIGGER_TYPES } from '@/lib/api/v1/flow-inputs';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';

type Row = Record<string, unknown>;

/** Throw 409 when another row in the account already uses `value` in `column`. */
async function assertUnique(
  ctx: ApiKeyContext,
  table: string,
  column: string,
  value: unknown,
  selfId: unknown,
  noun: string
) {
  if (typeof value !== 'string') return;
  const { data, error } = await ctx.supabase
    .from(table)
    .select(`id, ${column}`)
    .eq('account_id', ctx.accountId);
  if (error) throw new ApiError('internal', `Failed to check ${noun} names`, 500);
  const clash = ((data ?? []) as unknown as Row[]).some(
    (r) =>
      r.id !== selfId &&
      typeof r[column] === 'string' &&
      (r[column] as string).toLowerCase() === value.toLowerCase()
  );
  if (clash) throw new ApiError('conflict', `A ${noun} named "${value}" already exists`, 409);
}

/** Every id in `ids` must exist in `table` for this account. */
export async function assertOwned(
  ctx: ApiKeyContext,
  table: string,
  ids: Array<string | null | undefined>,
  noun: string,
  column = 'id'
) {
  for (const id of ids) {
    if (!id) continue;
    const { data, error } = await ctx.supabase
      .from(table)
      .select('id')
      .eq(column, id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new ApiError('internal', `Failed to check ${noun}`, 500);
    if (!data) throw badRequest(`${noun} ${id} was not found in this workspace`);
  }
}

export const TAGS: ResourceConfig = {
  resource: 'tag',
  table: 'tags',
  select: 'id, name, color, created_at',
  readScope: 'settings:read',
  writeScope: 'settings:write',
  auditUserColumn: 'user_id',
  schema: {
    name: { type: 'string', required: true, max: 60 },
    color: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/, patternHint: 'a hex color like #3b82f6' },
  },
  validate: async (ctx, data, _mode, existing) => {
    if ('name' in data) await assertUnique(ctx, 'tags', 'name', data.name, existing?.id, 'tag');
  },
};

export const CUSTOM_FIELDS: ResourceConfig = {
  resource: 'custom_field',
  table: 'custom_fields',
  select: 'id, field_name, field_type, created_at',
  readScope: 'settings:read',
  writeScope: 'settings:write',
  auditUserColumn: 'user_id',
  schema: {
    field_name: { type: 'string', required: true, max: 80 },
  },
  validate: async (ctx, data, _mode, existing) => {
    if ('field_name' in data) {
      await assertUnique(ctx, 'custom_fields', 'field_name', data.field_name, existing?.id, 'custom field');
    }
  },
};

export const PIPELINES: ResourceConfig = {
  resource: 'pipeline',
  table: 'pipelines',
  select: 'id, name, created_at',
  readScope: 'pipelines:read',
  writeScope: 'pipelines:write',
  auditUserColumn: 'user_id',
  schema: {
    name: { type: 'string', required: true, max: 80 },
  },
};

const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

export const DEALS: ResourceConfig = {
  resource: 'deal',
  table: 'deals',
  select:
    'id, pipeline_id, stage_id, contact_id, conversation_id, assigned_to, title, value, currency, notes, expected_close_date, status, created_at, updated_at',
  readScope: 'pipelines:read',
  writeScope: 'pipelines:write',
  auditUserColumn: 'user_id',
  filters: {
    pipeline_id: 'uuid',
    stage_id: 'uuid',
    contact_id: 'uuid',
    status: { enum: DEAL_STATUSES },
  },
  schema: {
    title: { type: 'string', required: true, max: 200 },
    pipeline_id: { type: 'uuid', required: true },
    stage_id: { type: 'uuid', required: true },
    contact_id: { type: 'uuid', required: true },
    conversation_id: { type: 'uuid', nullable: true },
    assigned_to: { type: 'uuid', nullable: true },
    value: { type: 'number', min: 0, max: 9_999_999_999 },
    currency: { type: 'string', max: 8 },
    notes: { type: 'text', max: 5000, nullable: true },
    expected_close_date: { type: 'date', nullable: true },
    status: { type: 'enum', values: DEAL_STATUSES },
  },
  onInsert: () => ({ status: 'open' }),
  validate: async (ctx, data, _mode, existing) => {
    await assertOwned(ctx, 'pipelines', [data.pipeline_id as string | undefined], 'Pipeline');
    await assertOwned(ctx, 'contacts', [data.contact_id as string | undefined], 'Contact');
    await assertOwned(ctx, 'conversations', [data.conversation_id as string | null | undefined], 'Conversation');
    await assertOwned(ctx, 'profiles', [data.assigned_to as string | null | undefined], 'Team member');

    // A stage must belong to the deal's (new or current) pipeline.
    const stageId = (data.stage_id ?? null) as string | null;
    const pipelineId = (data.pipeline_id ?? existing?.pipeline_id ?? null) as string | null;
    if (stageId || data.pipeline_id) {
      const effectiveStage = stageId ?? (existing?.stage_id as string | undefined);
      const { data: stage } = await ctx.supabase
        .from('pipeline_stages')
        .select('id, pipeline_id')
        .eq('id', effectiveStage ?? '')
        .maybeSingle();
      if (!stage || stage.pipeline_id !== pipelineId) {
        throw badRequest('stage_id must be a stage of the deal\'s pipeline');
      }
    }
  },
};


// ---------------------------------------------------------------
// Quick replies: plain text, or a saved interactive message.
// ---------------------------------------------------------------

/** The kind a quick reply ends up with after applying `data` to `existing`. */
function effectiveQuickReply(data: Row, existing: Row | null) {
  const kind = (data.kind ?? existing?.kind ?? 'text') as 'text' | 'interactive';
  const content_text = 'content_text' in data ? data.content_text : (existing?.content_text ?? null);
  const interactive_payload =
    'interactive_payload' in data ? data.interactive_payload : (existing?.interactive_payload ?? null);
  return { kind, content_text, interactive_payload };
}

export const QUICK_REPLIES: ResourceConfig = {
  resource: 'quick_reply',
  table: 'quick_replies',
  select: 'id, title, kind, content_text, interactive_payload, created_at, updated_at',
  readScope: 'settings:read',
  writeScope: 'settings:write',
  auditUserColumn: 'user_id',
  schema: {
    title: { type: 'string', required: true, max: 120 },
    kind: { type: 'enum', values: ['text', 'interactive'] },
    content_text: { type: 'text', max: 4096, nullable: true },
    interactive_payload: { type: 'json', nullable: true },
  },
  validate: async (_ctx, data, _mode, existing) => {
    const eff = effectiveQuickReply(data, existing);
    if (eff.kind === 'interactive') {
      const result = validateInteractivePayload(eff.interactive_payload);
      if (!result.ok) throw badRequest(`'interactive_payload': ${result.error}`);
    } else if (typeof eff.content_text !== 'string' || !eff.content_text.trim()) {
      throw badRequest("'content_text' is required for a text quick reply");
    }
  },
  normalize: (data, mode, existing) => {
    const eff = effectiveQuickReply(data, existing);
    const out: Row = { ...data };
    if (mode === 'create' || 'kind' in data || 'content_text' in data || 'interactive_payload' in data) {
      out.kind = eff.kind;
      if (eff.kind === 'interactive') {
        out.content_text = null;
        out.interactive_payload = eff.interactive_payload;
      } else {
        out.content_text = eff.content_text;
        out.interactive_payload = null;
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------
// Templates (read side; creating them goes through Meta, see
// /api/v1/templates POST) and the API audit trail.
// ---------------------------------------------------------------

export const TEMPLATES: ResourceConfig = {
  resource: 'template',
  table: 'message_templates',
  select:
    'id, name, category, language, header_type, header_content, body_text, footer_text, buttons, sample_values, status, meta_template_id, quality_score, rejection_reason, submission_error, last_submitted_at, created_at, updated_at',
  readScope: 'templates:read',
  writeScope: 'templates:write',
  schema: {},
  filters: { status: 'string', language: 'string', category: { enum: ['Marketing', 'Utility', 'Authentication'] } },
  noCreate: true,
  noDelete: true,
};

export const AUDIT_LOG: ResourceConfig = {
  resource: 'audit_entry',
  table: 'api_audit_log',
  select: 'id, api_key_id, action, resource_type, resource_id, summary, created_at',
  readScope: 'audit:read',
  writeScope: 'audit:read',
  schema: {},
  filters: { action: 'string', resource_type: 'string', api_key_id: 'uuid' },
  noCreate: true,
  noDelete: true,
};

export const FLOWS: ResourceConfig = {
  resource: 'flow',
  table: 'flows',
  select: 'id, name, description, status, trigger_type, trigger_config, entry_node_id, fallback_policy, created_at, updated_at',
  readScope: 'flows:read',
  writeScope: 'flows:write',
  schema: {},
  filters: { status: { enum: FLOW_STATUSES }, trigger_type: { enum: FLOW_TRIGGER_TYPES } },
  noCreate: true,
  noDelete: true,
};

export const AUTOMATIONS: ResourceConfig = {
  resource: 'automation',
  table: 'automations',
  select: 'id, name, description, trigger_type, trigger_config, is_active, created_at, updated_at',
  readScope: 'automations:read',
  writeScope: 'automations:write',
  schema: {},
  filters: { trigger_type: { enum: AUTOMATION_TRIGGER_TYPES } },
  noCreate: true,
  noDelete: true,
};
