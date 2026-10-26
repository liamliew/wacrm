// GET/PATCH/DELETE /api/v1/deals/{id}. PATCH { stage_id } moves a deal; { status } marks it open/won/lost.
import { item } from '@/lib/api/v1/crud';
import { DEALS } from '@/lib/api/v1/resources';

export const { GET, PATCH, DELETE } = item(DEALS);
