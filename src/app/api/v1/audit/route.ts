// ============================================================
// GET /api/v1/audit  (scope audit:read)
// What API keys changed, newest first: which key, which action, which
// resource, and the NAMES of the fields touched (never their values).
// Filters: ?action=ai.config.update  ?resource_type=tag  ?api_key_id=<uuid>
// ============================================================
import { collection } from '@/lib/api/v1/crud';
import { AUDIT_LOG } from '@/lib/api/v1/resources';

export const { GET } = collection(AUDIT_LOG);
