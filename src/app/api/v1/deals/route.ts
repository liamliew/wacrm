// GET/POST /api/v1/deals — list (filter by pipeline_id, stage_id, contact_id, status) and create deals.
import { collection } from '@/lib/api/v1/crud';
import { DEALS } from '@/lib/api/v1/resources';

export const { GET, POST } = collection(DEALS);
