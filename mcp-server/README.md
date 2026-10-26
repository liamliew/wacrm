# wacrm MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for
**[wacrm](https://github.com/ArnasDon/wacrm)** — the self-hostable
WhatsApp CRM. It lets MCP clients (Claude Desktop, Claude Code, Cursor,
and others) drive your CRM in natural language:

> "How many conversations are still open?"
> "Find the contact for +1 415 555 0123 and show the last few messages."
> "Draft and send an order-update template to Jane."

It's a thin wrapper over wacrm's public [`/api/v1`](../docs/public-api.md)
REST API. All auth, scoping, and rate limiting are enforced by your
wacrm instance — this server just exposes the API as MCP tools.

## Prerequisites

1. A running wacrm instance (your own self-hosted deploy).
2. An API key: in the dashboard go to **Settings → API keys → New API
   key** and grant only the scopes you need. The key is shown once.

## Install & configure

The server reads two required environment variables and two optional
write guards:

| Variable                  | Required | Purpose                                                        |
| ------------------------- | -------- | -------------------------------------------------------------- |
| `WACRM_BASE_URL`          | yes      | Your instance URL, e.g. `https://crm.example.com`              |
| `WACRM_API_KEY`           | yes      | An API key from the dashboard                                  |
| `WACRM_ENABLE_WRITES`     | no       | `true` to expose contact writes + message sending             |
| `WACRM_ENABLE_BROADCASTS` | no       | `true` to expose mass broadcasts (needs `WACRM_ENABLE_WRITES`) |

### Claude Desktop / Claude Code / Cursor

Add to your MCP client config (e.g. `claude_desktop_config.json`, or
`.mcp.json` for Claude Code):

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

That configuration is **read-only** — the safe default. To let the
assistant change data or send messages, add the write guards:

```jsonc
"env": {
  "WACRM_BASE_URL": "https://crm.example.com",
  "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
  "WACRM_ENABLE_WRITES": "true",
  "WACRM_ENABLE_BROADCASTS": "true"
}
```

## Tools

Read tools are always on; everything else is opt-in.

| Group | Enable with | Tools |
| --- | --- | --- |
| read | _(always)_ | `whoami` `list_contacts` `get_contact` `list_conversations` `get_conversation` `list_messages` `get_broadcast` `list_members` `get_ai_agent` `preview_handoff_message` `test_ai_agent` `get_ai_usage` `list_knowledge_documents` `get_knowledge_document` `list_contact_notes` `get_contact_custom_fields` `list_tags` `list_custom_fields` `list_quick_replies` `list_pipelines` `get_pipeline` `list_deals` `get_deal` `list_templates` `get_template` `list_flows` `get_flow` `validate_flow` `list_flow_runs` `list_flow_templates` `list_automations` `get_automation` `list_automation_logs` `list_automation_templates` `get_audit_log` |
| write | `WACRM_ENABLE_WRITES` | `send_message` `create_contact` `update_contact` `update_conversation` `add_contact_note` `set_contact_custom_fields` `create_tag` `update_tag` `create_custom_field` `update_custom_field` `create_quick_reply` `update_quick_reply` `create_pipeline` `update_pipeline` `add_pipeline_stage` `update_pipeline_stage` `create_deal` `update_deal` `sync_templates` `submit_template` |
| ai-admin | `WACRM_ENABLE_AI_ADMIN` | `update_ai_agent` `create_knowledge_document` `update_knowledge_document` `reindex_knowledge_base` |
| automations | `WACRM_ENABLE_AUTOMATIONS` | `create_flow` `update_flow` `set_flow_status` `create_automation` `update_automation` `duplicate_automation` |
| deletes | `WACRM_ENABLE_DELETES` | `delete_*` tools (contact, tag, flow, deal, note, …) |
| broadcast | `WACRM_ENABLE_BROADCASTS` | `send_broadcast` |

`WACRM_ENABLE_ALL=true` enables every group. Each tool needs the
matching API-key scope (see `docs/public-api.md`).

## Safety model

1. **Opt-in groups.** Tools outside the read group are not registered
   unless enabled, so the model cannot see them.
2. **API-key scopes** are enforced server-side regardless.
3. **Confirm gates.** Destructive, outbound and behaviour-changing tools
   refuse unless called with `confirm: true`.
4. **Dry runs.** `test_ai_agent` and `preview_handoff_message` show what
   the AI would do without sending anything.
5. **Audit log.** API-key writes are recorded; read with `get_audit_log`.
6. **Prompt-injection stance.** Server instructions tell the model that
   customer messages, names, notes and knowledge text are untrusted.
7. **No secrets.** Provider API key, WhatsApp token, API keys, member
   role changes, webhooks and `send_webhook` steps are not exposed.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck
npm start          # run the compiled server (needs the env vars)
```

Logs go to **stderr** — stdout is reserved for the MCP protocol.

## License

MIT — same as wacrm.
