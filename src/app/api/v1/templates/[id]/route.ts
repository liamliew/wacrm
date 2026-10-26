// GET /api/v1/templates/{id}  (templates:read). Editing or deleting a template stays in the dashboard.
import { item } from '@/lib/api/v1/crud';
import { TEMPLATES } from '@/lib/api/v1/resources';

export const { GET } = item(TEMPLATES);
