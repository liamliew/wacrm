// ============================================================
// Adapt a dashboard-shaped response ({ ...fields } or { error: string })
// into the public API envelope. Lets /api/v1 routes run the same shared
// library code the dashboard routes run (template submit / sync) without
// duplicating it.
// ============================================================

import { NextResponse } from 'next/server';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_failed',
  429: 'rate_limited',
  502: 'meta_error',
};

export async function adaptDashboardResponse(res: Response): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  if (res.ok) return NextResponse.json({ data: body }, { status: res.status });

  const message = typeof body.error === 'string' ? body.error : 'Request failed';
  const { error: _error, ...rest } = body;
  void _error;
  return NextResponse.json(
    {
      error: {
        code: CODE_BY_STATUS[res.status] ?? (res.status >= 500 ? 'internal' : 'bad_request'),
        message,
        ...(Object.keys(rest).length ? { details: rest } : {}),
      },
    },
    { status: res.status }
  );
}
