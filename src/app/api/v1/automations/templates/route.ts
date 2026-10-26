// GET /api/v1/automations/templates (automations:read) — ready-made automations for POST { template }.
import { handler } from '@/lib/api/v1/route';
import { ok } from '@/lib/api/v1/respond';
import { AUTOMATION_TEMPLATES } from '@/lib/automations/templates';

export const GET = handler('automations:read', async () =>
  ok(
    Object.entries(AUTOMATION_TEMPLATES).map(([slug, t]) => ({
      slug,
      name: t.name,
      description: t.description,
      trigger_type: t.trigger_type,
      step_count: t.steps.length,
    }))
  )
);
