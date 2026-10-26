// ============================================================
// GET  /api/v1/contacts/{id}/notes — notes, newest first (contacts:read)
// POST /api/v1/contacts/{id}/notes — add a note          (contacts:write)
//   body: { note_text }
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString, parseBody, readBody } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import type { ApiKeyContext } from '@/lib/auth/api-context';

const NOTE_SELECT = 'id, contact_id, note_text, created_at';

export async function contactInAccount(ctx: ApiKeyContext, id: string): Promise<boolean> {
  if (!isUuidString(id)) return false;
  const { data } = await ctx.supabase
    .from('contacts')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return !!data;
}

export const GET = handler<{ id: string }>('contacts:read', async (ctx, _req, { id }) => {
  if (!(await contactInAccount(ctx, id))) return fail('not_found', 'Contact not found', 404);
  const { data, error } = await ctx.supabase
    .from('contact_notes')
    .select(NOTE_SELECT)
    .eq('contact_id', id)
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return fail('internal', 'Failed to list notes', 500);
  return ok(data ?? []);
});

export const POST = handler<{ id: string }>('contacts:write', async (ctx, request, { id }) => {
  const body = parseBody(
    await readBody(request),
    { note_text: { type: 'text', required: true, max: 5000 } },
    { partial: false }
  );
  if (!(await contactInAccount(ctx, id))) return fail('not_found', 'Contact not found', 404);
  const { data, error } = await ctx.supabase
    .from('contact_notes')
    .insert({
      contact_id: id,
      account_id: ctx.accountId,
      user_id: await resolveAuditUserId(ctx.supabase, ctx.accountId),
      note_text: (body.note_text as string).trim(),
    })
    .select(NOTE_SELECT)
    .single();
  if (error || !data) return fail('internal', 'Failed to add note', 500);
  await recordAudit(ctx, {
    action: 'contact_note.create',
    resourceType: 'contact_note',
    resourceId: (data as unknown as { id: string }).id,
    fields: ['note_text'],
    detail: { contact_id: id },
  });
  return ok(data, 201);
});
