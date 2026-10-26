// ============================================================
// Handler wrapper for /api/v1 routes.
//
// Every route does the same dance: authenticate the key and check its
// scope, await the dynamic params, run the handler, map thrown
// ApiErrors to the envelope. `handler(scope, fn)` is that dance, so a
// route file is just the part that differs.
// ============================================================

import { requireApiKey, type ApiKeyContext } from '@/lib/auth/api-context';
import type { ApiScope } from '@/lib/api-keys/scopes';
import { toApiErrorResponse } from '@/lib/api/v1/respond';

type Params = Record<string, string>;

export function handler<P extends Params = Params>(
  scope: ApiScope,
  fn: (ctx: ApiKeyContext, request: Request, params: P) => Promise<Response>
) {
  return async (
    request: Request,
    context?: { params: Promise<P> }
  ): Promise<Response> => {
    try {
      const ctx = await requireApiKey(request, scope);
      const params = context?.params ? await context.params : ({} as P);
      return await fn(ctx, request, params);
    } catch (err) {
      return toApiErrorResponse(err);
    }
  };
}
