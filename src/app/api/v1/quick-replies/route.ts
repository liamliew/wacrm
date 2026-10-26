// GET/POST /api/v1/quick-replies — reusable replies (text or interactive buttons/list).
import { collection } from '@/lib/api/v1/crud';
import { QUICK_REPLIES } from '@/lib/api/v1/resources';

export const { GET, POST } = collection(QUICK_REPLIES);
