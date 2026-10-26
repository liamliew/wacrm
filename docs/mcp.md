# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so you can drive your CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

It lives in [`mcp-server/`](../mcp-server) and is published to npm as
[`wacrm-mcp`](https://www.npmjs.com/package/wacrm-mcp). Under the hood
it's a thin wrapper over the [public API](./public-api.md), so every
request is authenticated and scoped by your instance exactly like any
other API call.

## Quick start

1. Create an API key in the dashboard: **Settings → API keys**. Grant
   only the scopes your assistant needs (a read-only assistant only
   needs the `*:read` scopes).
2. Add the server to your MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.example.com",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
         }
       }
     }
   }
   ```

That's **read-only** — the safe default. To let the assistant change
data or send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

Tool groups, each opt-in via env (all but reads also need
`WACRM_ENABLE_WRITES=true`; `WACRM_ENABLE_ALL=true` turns everything on):

| Group | Env flag | Covers |
| --- | --- | --- |
| read | _always_ | contacts, conversations, messages, AI agent config, knowledge base, usage, tags, fields, pipelines, deals, templates, flows, automations, members, audit log, `test_ai_agent` and `preview_handoff_message` dry runs |
| write | `WACRM_ENABLE_WRITES` | send messages, contacts, notes, conversations (assign/close/pause AI), tags, fields, quick replies, pipelines, deals, template sync/submit |
| ai-admin | `WACRM_ENABLE_AI_ADMIN` | `update_ai_agent` (prompt, model, switches, handoff), knowledge-base documents, reindex |
| automations | `WACRM_ENABLE_AUTOMATIONS` | create/update flows and automations, flow status |
| deletes | `WACRM_ENABLE_DELETES` | delete tools (all require `confirm: true`) |
| broadcast | `WACRM_ENABLE_BROADCASTS` | launch broadcasts (`confirm: true`) |

**Not exposed on purpose:** AI provider API key, WhatsApp access token,
API-key management, member role/invite/remove, outbound webhooks, and
`send_webhook` automation steps.

## Safety

Customer messages are untrusted text that an LLM will read, so the
server limits what a prompt-injected model can do: groups are opt-in,
risky actions need `confirm: true`, the AI agent and automations can be
tried first (`test_ai_agent`, `preview_handoff_message`), every API-key
write lands in the audit log (`get_audit_log`), and the server sends
instructions telling the model not to obey text found in customer data.
Give the key only the scopes you need. Transport is stdio only. See the
[server README](../mcp-server/README.md) for the tool list.
