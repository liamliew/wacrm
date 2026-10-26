// ============================================================
// GET /api/v1/contacts/{id}/custom-fields — every defined field with this contact's value (contacts:read)
// PUT /api/v1/contacts/{id}/custom-fields — set values                                      (contacts:write)
//   body: { values: { "<custom_field_id>": "text" | null } }
//   null or "" clears a value. Fields are defined via /api/v1/custom-fields.
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail, badRequest } from '@/lib/api/v1/respond';
import { isUuidString, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { contactInAccount } from '../notes/route';

async function readValues(ctx: Parameters<typeof contactInAccount>[0], contactId: string) {
  const [fields, values] = await Promise.all([
    ctx.supabase.from('custom_fields').select('id, field_name').eq('account_id', ctx.accountId).order('field_name'),
    ctx.supabase.from('contact_custom_values').select('custom_field_id, value').eq('contact_id', contactId),
  ]);
  if (fields.error || values.error) return null;
  const byField = new Map(
    ((values.data ?? []) as Array<{ custom_field_id: string; value: string | null }>).map((v) => [v.custom_field_id, v.value])
  );
  return ((fields.data ?? []) as Array<{ id: string; field_name: string }>).map((f) => ({
    field_id: f.id,
    field_name: f.field_name,
    value: byField.get(f.id) ?? null,
  }));
}

export const GET = handler<{ id: string }>('contacts:read', async (ctx, _req, { id }) => {
  if (!(await contactInAccount(ctx, id))) return fail('not_found', 'Contact not found', 404);
  const out = await readValues(ctx, id);
  return out ? ok(out) : fail('internal', 'Failed to read custom fields', 500);
});

export const PUT = handler<{ id: string }>('contacts:write', async (ctx, request, { id }) => {
  const body = await readBody(request);
  for (const k of Object.keys(body)) if (k !== 'values') throw badRequest(`Unknown field '${k}'. Allowed: values`);
  const values = body.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw badRequest("'values' must be an object of { custom_field_id: value }");
  }
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length === 0) throw badRequest("'values' must set at least one field");
  if (entries.length > 100) throw badRequest("'values' can set at most 100 fields at once");
  for (const [fieldId, v] of entries) {
    if (!isUuidString(fieldId)) throw badRequest(`'${fieldId}' is not a custom field id (UUID)`);
    if (v !== null && typeof v !== 'string') throw badRequest(`Value for ${fieldId} must be a string or null`);
    if (typeof v === 'string' && v.length > 2000) throw badRequest(`Value for ${fieldId} must be at most 2000 characters`);
  }

  if (!(await contactInAccount(ctx, id))) return fail('not_found', 'Contact not found', 404);

  // Every field id must be one of this account's fields.
  const { data: known } = await ctx.supabase
    .from('custom_fields')
    .select('id')
    .eq('account_id', ctx.accountId)
    .in('id', entries.map(([k]) => k));
  const knownIds = new Set(((known ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const [fieldId] of entries) {
    if (!knownIds.has(fieldId)) throw badRequest(`Custom field ${fieldId} was not found in this workspace`);
  }

  const toSet = entries.filter(([, v]) => typeof v === 'string' && v.trim() !== '');
  const toClear = entries.filter(([, v]) => !(typeof v === 'string' && v.trim() !== ''));

  if (toSet.length > 0) {
    const { error } = await ctx.supabase
      .from('contact_custom_values')
      .upsert(
        toSet.map(([custom_field_id, value]) => ({ contact_id: id, custom_field_id, value })),
        { onConflict: 'contact_id,custom_field_id' }
      );
    if (error) {
      console.error('[api/v1/contacts/custom-fields] upsert error:', error);
      return fail('internal', 'Failed to save custom field values', 500);
    }
  }
  if (toClear.length > 0) {
    const { error } = await ctx.supabase
      .from('contact_custom_values')
      .delete()
      .eq('contact_id', id)
      .in('custom_field_id', toClear.map(([k]) => k));
    if (error) return fail('internal', 'Failed to clear custom field values', 500);
  }

  await recordAudit(ctx, {
    action: 'contact.custom_fields.update',
    resourceType: 'contact',
    resourceId: id,
    fields: entries.map(([k]) => k),
  });
  const out = await readValues(ctx, id);
  return out ? ok(out) : fail('internal', 'Failed to read custom fields', 500);
});
