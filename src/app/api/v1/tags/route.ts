// GET/POST /api/v1/tags — list and create tags (settings:read / settings:write).
import { collection } from '@/lib/api/v1/crud';
import { TAGS } from '@/lib/api/v1/resources';

export const { GET, POST } = collection(TAGS);
