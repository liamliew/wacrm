// GET/POST /api/v1/custom-fields — contact custom field definitions.
import { collection } from '@/lib/api/v1/crud';
import { CUSTOM_FIELDS } from '@/lib/api/v1/resources';

export const { GET, POST } = collection(CUSTOM_FIELDS);
