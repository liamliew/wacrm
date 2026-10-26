// GET /api/v1/flows/templates (flows:read) — built-in starting points for POST /flows { template_slug }.
import { handler } from '@/lib/api/v1/route';
import { ok } from '@/lib/api/v1/respond';
import { listFlowTemplates } from '@/lib/flows/templates';

export const GET = handler('flows:read', async () =>
  ok(
    listFlowTemplates().map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      trigger_type: t.trigger_type,
      node_count: t.nodes.length,
    }))
  )
);
