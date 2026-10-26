// ============================================================
// API key scopes — pure, unit-testable, no I/O.
//
// Authorization for the public API is *scopes-only*: a key's
// capabilities are defined entirely by the scopes granted to it at
// creation, independent of the role of the user who minted it. (We
// still gate *key creation* at admin+, so only trusted members can
// hand out capabilities — see the management routes.)
//
// A scope is `<resource>:<action>`. Endpoints declare the single
// scope they require; `requireApiKey(request, scope)` enforces it.
// Adding a capability = one entry here + the endpoint that checks
// it. No migration needed (the DB stores scopes as a free `text[]`).
// ============================================================

export const API_SCOPES = [
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'broadcasts:send',
  'webhooks:manage',
  // --- Workspace control (added for the MCP server and other agents) ---
  'conversations:write',
  'contacts:delete',
  'members:read',
  'ai:read',
  'ai:write',
  'knowledge:read',
  'knowledge:write',
  'settings:read',
  'settings:write',
  'templates:read',
  'templates:write',
  'pipelines:read',
  'pipelines:write',
  'flows:read',
  'flows:write',
  'automations:read',
  'automations:write',
  'audit:read',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Human-readable descriptions, surfaced in the key-creation UI. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  'messages:send': 'Send WhatsApp messages',
  'messages:read': 'Read messages and their delivery status',
  'contacts:read': 'List and read contacts',
  'contacts:write': 'Create and update contacts',
  'conversations:read': 'List and read conversations',
  'broadcasts:send': 'Launch broadcast campaigns',
  'webhooks:manage': 'Register and manage outbound event webhooks',
  'conversations:write':
    'Assign, open/close and pause the AI on conversations',
  'contacts:delete': 'Delete contacts (and their conversations)',
  'members:read': 'List team members (names and roles)',
  'ai:read': 'Read the AI agent setup, usage, and test it in the playground',
  'ai:write':
    'Change the AI agent: prompt, switches, model, reply limit, handoff settings',
  'knowledge:read': 'Read the AI knowledge base',
  'knowledge:write': 'Add, edit and delete knowledge-base documents',
  'settings:read': 'Read quick replies, tags and custom fields',
  'settings:write': 'Create, edit and delete quick replies, tags and custom fields',
  'templates:read': 'Read WhatsApp message templates',
  'templates:write': 'Create, sync, submit and delete WhatsApp templates',
  'pipelines:read': 'Read sales pipelines, stages and deals',
  'pipelines:write': 'Create, edit and delete pipelines, stages and deals',
  'flows:read': 'Read flows and their runs',
  'flows:write': 'Create, edit, activate and delete flows',
  'automations:read': 'Read automations and their logs',
  'automations:write': 'Create, edit, activate and delete automations',
  'audit:read': 'Read the log of changes made through API keys',
};

/**
 * Scopes that let a key change how the workspace behaves or remove data,
 * not just read it or send one message. The key-creation UI marks these
 * so granting them is a deliberate choice.
 */
export const SENSITIVE_SCOPES: readonly ApiScope[] = [
  'messages:send',
  'contacts:write',
  'webhooks:manage',
  'conversations:write',
  'contacts:delete',
  'ai:write',
  'knowledge:write',
  'settings:write',
  'templates:write',
  'pipelines:write',
  'flows:write',
  'automations:write',
  'broadcasts:send',
];

/** Type-narrow an unknown value into a valid `ApiScope`. */
export function isApiScope(value: unknown): value is ApiScope {
  return (
    typeof value === 'string' &&
    (API_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Validate and de-duplicate a caller-supplied scope list. Returns
 * the cleaned list, or `null` if any entry is not a known scope
 * (callers turn that into a 400). An empty input is valid — it
 * yields a key that authenticates but can't do anything beyond the
 * scope-free endpoints (e.g. `GET /api/v1/me`).
 */
export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: ApiScope[] = [];
  for (const entry of input) {
    if (!isApiScope(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * True iff `granted` contains `required`. The single source of
 * truth for "is this key allowed to do X?" — both `requireApiKey`
 * and any future inline check should call this rather than poking
 * at the array directly.
 */
export function hasScope(
  granted: readonly string[],
  required: ApiScope
): boolean {
  return granted.includes(required);
}
