// GET/PATCH/DELETE /api/v1/quick-replies/{id}
import { item } from '@/lib/api/v1/crud';
import { QUICK_REPLIES } from '@/lib/api/v1/resources';

export const { GET, PATCH, DELETE } = item(QUICK_REPLIES);
