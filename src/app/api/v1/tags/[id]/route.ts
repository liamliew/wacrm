// GET/PATCH/DELETE /api/v1/tags/{id}. Deleting a tag removes it from every contact.
import { item } from '@/lib/api/v1/crud';
import { TAGS } from '@/lib/api/v1/resources';

export const { GET, PATCH, DELETE } = item(TAGS);
