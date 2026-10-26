// ============================================================
// Flows and automations — registered only when
// WACRM_ENABLE_AUTOMATIONS (and WACRM_ENABLE_WRITES) are set.
//
// Both run on their own once active and can message customers, so they
// are created as DRAFTS, validated by the API before they go live, and
// activating one needs confirm=true.
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { id, registerSpecs, type ToolSpec } from './dsl.js';

const enc = encodeURIComponent;

const NODE_TYPES = ['start', 'send_message', 'send_buttons', 'send_list', 'send_media', 'collect_input', 'condition', 'set_tag', 'handoff', 'end'] as const;
const flowNode = z.object({
  node_key: z.string().describe('Unique within the flow: letters, digits, _ or -.'),
  node_type: z.enum(NODE_TYPES),
  config: z.record(z.string(), z.unknown()).optional().describe('Depends on node_type; copy the shape from get_flow or list_flow_templates.'),
  position_x: z.number().int().optional(),
  position_y: z.number().int().optional(),
});

const TRIGGERS = ['new_message_received', 'first_inbound_message', 'keyword_match', 'new_contact_created', 'conversation_assigned', 'tag_added', 'time_based', 'interactive_reply'] as const;
const STEPS_DOC =
  'Steps run in order. Each is { step_type, step_config }; a "condition" step also has branches: { yes: [steps], no: [steps] }. Types: send_message {text}, send_buttons / send_list (interactive payload), send_template {template_name, language, variables}, add_tag / remove_tag {tag_id}, assign_conversation {mode: specific|round_robin, agent_id}, update_contact_field {field, value}, create_deal {pipeline_id, stage_id, title, value}, wait {amount, unit}, condition {subject, operand, value}, close_conversation. Webhook steps can only be made in the dashboard. Copy exact shapes from get_automation or list_automation_templates.';

const ACTIVATE =
  ' An active automation/flow runs by itself and can message real customers. It is created as a draft; the API refuses to activate one that is incomplete.';

export function registerAutomationTools(server: McpServer, c: WacrmClient): string[] {
  const specs: ToolSpec[] = [
    // --- Flows -------------------------------------------------------------------
    {
      name: 'create_flow',
      title: 'Create a flow (draft)',
      description:
        'Create a conversation flow as a DRAFT. Either name + trigger_type (keyword | first_inbound_message | manual) + trigger_config (keyword: { keywords: [...], match_type: "exact"|"contains" }), or template_slug from list_flow_templates to start from a built-in flow. Then add nodes with update_flow, check with validate_flow, and activate with set_flow_status.',
      kind: 'write',
      input: {
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(500).nullable().optional(),
        trigger_type: z.enum(['keyword', 'first_inbound_message', 'manual']).optional(),
        trigger_config: z.record(z.string(), z.unknown()).optional(),
        template_slug: z.string().optional(),
      },
      run: (a) => c.post('/flows', a),
    },
    {
      name: 'update_flow',
      title: 'Edit a flow',
      description:
        'Edit a flow\'s name, description, trigger, entry_node_id, fallback_policy, and/or REPLACE its whole node list with `nodes` (send all nodes, not just changes: read get_flow first). Nodes reference each other by node_key (next_node_key, true_next, button next_node_key). A flow that is ACTIVE must stay valid: the save is refused with the issues if it would break it.',
      kind: 'write',
      input: {
        id: id('Flow'),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(500).nullable().optional(),
        trigger_type: z.enum(['keyword', 'first_inbound_message', 'manual']).optional(),
        trigger_config: z.record(z.string(), z.unknown()).optional(),
        entry_node_id: z.string().nullable().optional().describe('node_key of the first node (usually the "start" node).'),
        fallback_policy: z.record(z.string(), z.unknown()).optional(),
        nodes: z.array(flowNode).max(200).optional(),
      },
      run: ({ id, ...b }) => c.put(`/flows/${enc(id)}`, b),
    },
    {
      name: 'set_flow_status',
      title: 'Activate, pause or archive a flow',
      description:
        'Set a flow to "active", "draft" or "archived". Activating validates it first (refused with the issues if incomplete). Moving to draft or archived ends the flow\'s in-progress runs.' + ACTIVATE,
      kind: 'write',
      confirmWhen: (a) => (a.status === 'active' ? 'activating a flow lets it start talking to real customers.' : null),
      input: { id: id('Flow'), status: z.enum(['draft', 'active', 'archived']) },
      run: ({ id, status }) => c.post(`/flows/${enc(id)}/status`, { status }),
    },

    // --- Automations --------------------------------------------------------------
    {
      name: 'create_automation',
      title: 'Create an automation',
      description:
        'Create an automation: name + trigger_type + trigger_config + steps, or template (a slug from list_automation_templates). It is created INACTIVE unless is_active=true, and then it is validated and needs confirm=true. ' + STEPS_DOC + ACTIVATE,
      kind: 'write',
      confirmWhen: (a) => (a.is_active === true ? 'creating an automation as active lets it start acting on real customers.' : null),
      input: {
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(500).nullable().optional(),
        trigger_type: z.enum(TRIGGERS).optional(),
        trigger_config: z.record(z.string(), z.unknown()).optional().describe('e.g. keyword_match: { keywords: [...], match_type: "contains" }; tag_added: { tag_id }; time_based: { schedule }; interactive_reply: { reply_ids: [...] }.'),
        is_active: z.boolean().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
        template: z.string().optional(),
      },
      run: (a) => c.post('/automations', a),
    },
    {
      name: 'update_automation',
      title: 'Edit, activate or pause an automation',
      description:
        'Edit an automation\'s name, description, trigger, and/or REPLACE its whole step tree with `steps` (read get_automation first and send the full tree). is_active=true activates it (validated, needs confirm=true); is_active=false pauses it. ' + STEPS_DOC,
      kind: 'write',
      confirmWhen: (a) => (a.is_active === true ? 'activating an automation lets it act on real customers.' : null),
      input: {
        id: id('Automation'),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(500).nullable().optional(),
        trigger_type: z.enum(TRIGGERS).optional(),
        trigger_config: z.record(z.string(), z.unknown()).optional(),
        is_active: z.boolean().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
      },
      run: ({ id, ...b }) => c.patch(`/automations/${enc(id)}`, b),
    },
    {
      name: 'duplicate_automation',
      title: 'Duplicate an automation',
      description: 'Make an inactive copy ("Copy of …") of an automation with all its steps, to edit safely.',
      kind: 'write',
      input: { id: id('Automation') },
      run: ({ id }) => c.post(`/automations/${enc(id)}/duplicate`),
    },
  ];
  return registerSpecs(server, specs);
}
