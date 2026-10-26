// DELETE /api/v1/contacts/{id}/notes/{noteId}  (scope contacts:write)
import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { isUuidString } from '@/lib/api/v1/input';
import { recordAudit } from '@/lib/api/v1/audit';

export const DELETE = handler<{ id: string; noteId: string }>('contacts:write', async (ctx, _req, { id, noteId }) => {
  if (!isUuidString(id) || !isUuidString(noteId)) return fail('not_found', 'Note not found', 404);
  const { data, error } = await ctx.supabase
    .from('contact_notes')
    .delete()
    .eq('id', noteId)
    .eq('contact_id', id)
    .eq('account_id', ctx.accountId)
    .select('id');
  if (error) return fail('internal', 'Failed to delete note', 500);
  if (!data || data.length === 0) return fail('not_found', 'Note not found', 404);
  await recordAudit(ctx, { action: 'contact_note.delete', resourceType: 'contact_note', resourceId: noteId });
  return ok({ id: noteId, deleted: true });
});
