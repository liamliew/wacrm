// GET/PATCH/DELETE /api/v1/custom-fields/{id}. Deleting a field removes its values on every contact.
import { item } from '@/lib/api/v1/crud';
import { CUSTOM_FIELDS } from '@/lib/api/v1/resources';

export const { GET, PATCH, DELETE } = item(CUSTOM_FIELDS);
