// ============================================================
// POST /api/v1/ai/handoff/preview  (scope ai:read)
//
// Dry run of the customer message: which handoff message the saved
// settings would send at a given moment, with placeholders filled in.
// Nothing is sent. Body (all optional):
//   time    "YYYY-MM-DDTHH:mm" read in the saved time zone (default: now)
//   reason  "model" (the AI hands off) or "cap" (reply limit reached)
// ============================================================

import { handler } from '@/lib/api/v1/route';
import { ok, fail } from '@/lib/api/v1/respond';
import { parseBody, readOptionalBody } from '@/lib/api/v1/input';
import { loadHandoffSettings } from '@/lib/ai/handoff-settings';
import { resolveHandoffMessage, wallTimeToDate } from '@/lib/ai/handoff-hours';
import { badRequest } from '@/lib/api/v1/respond';

export const POST = handler('ai:read', async (ctx, request) => {
  const raw = await readOptionalBody(request);
  const body = parseBody(raw, {
    time: { type: 'string', max: 16, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, patternHint: 'like 2026-10-26T20:00' },
    reason: { type: 'enum', values: ['model', 'cap'] },
  }, { partial: false });

  const settings = await loadHandoffSettings(ctx.supabase, ctx.accountId);
  if (!settings) return fail('conflict', 'The AI provider is not set up yet.', 409);

  let now = new Date();
  if (typeof body.time === 'string') {
    const at = wallTimeToDate(body.time, settings.timeZone);
    if (!at) throw badRequest("'time' is not a valid date and time");
    now = at;
  }
  const reason = (body.reason as 'model' | 'cap' | undefined) ?? 'model';
  const r = resolveHandoffMessage({ settings, reason, now });
  return ok({
    reason,
    time_zone: settings.timeZone,
    at: now.toISOString(),
    team_open: r.open,
    hours_not_set: r.hoursMissing,
    which: r.which,
    would_send: r.send,
    message: r.text,
    message_enabled: settings.enabled,
  });
});
