# AI handoff: hours and customer messages

When the AI assistant hands a conversation to a human, it can tell the
customer. Configure it under **AI Agents → Handoff** (admins and owners).

Requires migration `060_ai_handoff_settings.sql` (apply it before
deploying this code: the AI config API reads the new columns).

## What triggers a handoff

- **The model hands off** (it can't answer, or returns nothing): the bot
  pauses on the thread, the chat is routed to **Hand off to** (or left
  unassigned), a short internal note is saved, and, if enabled, the
  **open** or **closed** message is sent.
- **The reply limit is reached** (the *Max auto-replies per conversation*
  setting): the next customer message hands off the same way and the
  **reply limit** message is sent. Before this change the bot just went
  quiet at the limit.

Each handoff sends at most one message. The pause is applied with a
conditional update, so two messages arriving together cannot both send.
**Resume AI** in the inbox re-enables the bot; a later handoff on that
thread is a new handoff and can message again.

The message is sent through the same WhatsApp path as the bot's replies
and saved as a bot message (without the "AI" badge: it is fixed text). If
sending fails it is logged and the handoff still stands.

## Settings

| Setting | Notes |
| --- | --- |
| Hand off to | Same value as before (`ai_configs.handoff_agent_id`), moved here. "Unassigned" leaves the chat in the shared queue. |
| Time zone | IANA name; default `Asia/Kuala_Lumpur`. |
| Weekly hours | Per day: open toggle, start, end. A range is open from start up to, but not including, end. End must be after start; overnight ranges aren't supported yet. |
| Send a message on handoff | Off by default. |
| Open / closed / reply limit messages | Up to 1000 characters each. |

If no hours are saved, the **open** message is always used (the tab shows
a warning). If every day is closed, the **closed** message is used and
`{{next_open_day}}` reads "soon".

## Placeholders

- `{{next_open_day}}`: "today", "tomorrow" or "on Monday"
- `{{next_open_time}}`: "10am", "9:30am"
- `{{hours_today}}`: "9am–6pm", or "closed today"

The **Preview** card shows the message for any test time, using the
settings on screen even before saving.

## Code

- `src/lib/ai/handoff-hours.ts`: pure `isOpen`, `nextOpen`, renderer.
- `src/lib/ai/auto-reply.ts`: `handOffConversation` / `sendHandoffMessage`.
- `src/app/api/ai/handoff/route.ts`: `PUT` (admin+); reads go through `GET /api/ai/config`.
