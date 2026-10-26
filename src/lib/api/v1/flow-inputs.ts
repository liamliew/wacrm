// ============================================================
// Input validation for flows and automations on /api/v1.
//
// These bodies are graphs (flow nodes, automation steps) that an LLM
// will often write, so the checks here are about SHAPE and BOUNDS: known
// node/step types, unique keys, sane sizes. Whether a flow or automation
// is complete enough to run is decided by the existing activation
// validators (`validateFlowForActivation`, `validate*ForActivation`),
// which the routes call before anything goes live.
// ============================================================

import { badRequest } from '@/lib/api/v1/respond';

export const FLOW_NODE_TYPES = [
  'start', 'send_message', 'send_buttons', 'send_list', 'send_media',
  'collect_input', 'condition', 'set_tag', 'handoff', 'end',
] as const;
export const FLOW_TRIGGER_TYPES = ['keyword', 'first_inbound_message', 'manual'] as const;
export const FLOW_STATUSES = ['draft', 'active', 'archived'] as const;
const MAX_FLOW_NODES = 200;

export interface FlowNodeInput {
  node_key: string;
  node_type: (typeof FLOW_NODE_TYPES)[number];
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function isPlainObject(v: unknown): string | null {
  return isObject(v) ? null : 'must be an object';
}

export function parseFlowNodes(raw: unknown): FlowNodeInput[] {
  if (!Array.isArray(raw)) throw badRequest("'nodes' must be an array");
  if (raw.length > MAX_FLOW_NODES) throw badRequest(`'nodes' can have at most ${MAX_FLOW_NODES} entries`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!isObject(entry)) throw badRequest(`nodes[${i}] must be an object`);
    for (const k of Object.keys(entry)) {
      if (!['node_key', 'node_type', 'config', 'position_x', 'position_y'].includes(k)) {
        throw badRequest(`nodes[${i}]: unknown field '${k}'`);
      }
    }
    const key = entry.node_key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw badRequest(`nodes[${i}].node_key must be 1-64 letters, digits, '_' or '-'`);
    }
    if (seen.has(key)) throw badRequest(`nodes[${i}].node_key '${key}' is used twice`);
    seen.add(key);
    if (typeof entry.node_type !== 'string' || !(FLOW_NODE_TYPES as readonly string[]).includes(entry.node_type)) {
      throw badRequest(`nodes[${i}].node_type must be one of: ${FLOW_NODE_TYPES.join(', ')}`);
    }
    if (entry.config !== undefined && !isObject(entry.config)) throw badRequest(`nodes[${i}].config must be an object`);
    for (const axis of ['position_x', 'position_y'] as const) {
      const v = entry[axis];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 100_000)) {
        throw badRequest(`nodes[${i}].${axis} must be a whole number`);
      }
    }
    return {
      node_key: key,
      node_type: entry.node_type as FlowNodeInput['node_type'],
      config: (entry.config as Record<string, unknown>) ?? {},
      position_x: (entry.position_x as number) ?? 0,
      position_y: (entry.position_y as number) ?? 0,
    };
  });
}

// ---------------------------------------------------------------
// Automations
// ---------------------------------------------------------------

export const AUTOMATION_TRIGGER_TYPES = [
  'new_message_received', 'first_inbound_message', 'keyword_match', 'new_contact_created',
  'conversation_assigned', 'tag_added', 'time_based', 'interactive_reply',
] as const;

/**
 * Step types the API may create. `send_webhook` is deliberately absent: it
 * posts contact data to an arbitrary URL with arbitrary headers, which makes
 * it a ready-made way to move data out of the workspace (or to smuggle a
 * secret in a header). Like keys and tokens, it stays a dashboard-only action.
 */
export const AUTOMATION_STEP_TYPES = [
  'send_message', 'send_buttons', 'send_list', 'send_template', 'add_tag', 'remove_tag',
  'assign_conversation', 'update_contact_field', 'create_deal', 'wait', 'condition',
  'close_conversation',
] as const;

const HIDDEN = '[hidden: set in the dashboard]';

/**
 * Copy of a step tree that is safe to return to an API caller: webhook
 * URLs' headers and bodies (which may carry credentials) are hidden. The
 * walk follows both the nested `branches` form and any `children`.
 */
export function redactSteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((s) => {
    if (!isObject(s)) return s;
    const out: Record<string, unknown> = { ...s };
    if (s.step_type === 'send_webhook' && isObject(s.step_config)) {
      const { url, ...rest } = s.step_config as Record<string, unknown>;
      out.step_config = {
        url,
        ...(rest.headers !== undefined ? { headers: HIDDEN } : {}),
        ...(rest.body_template !== undefined ? { body_template: HIDDEN } : {}),
      };
    }
    if (isObject(s.branches)) {
      out.branches = {
        ...(s.branches.yes !== undefined ? { yes: redactSteps(s.branches.yes) } : {}),
        ...(s.branches.no !== undefined ? { no: redactSteps(s.branches.no) } : {}),
      };
    }
    if (Array.isArray(s.children)) out.children = redactSteps(s.children);
    return out;
  });
}

const MAX_ROOT_STEPS = 50;
const MAX_TOTAL_STEPS = 100;
const MAX_DEPTH = 5;

export interface StepInput {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepInput[]; no?: StepInput[] };
}

/** Validate the nested steps the builder sends (conditions carry yes/no branches). */
export function parseAutomationSteps(raw: unknown): StepInput[] {
  if (!Array.isArray(raw)) throw badRequest("'steps' must be an array");
  if (raw.length > MAX_ROOT_STEPS) throw badRequest(`'steps' can have at most ${MAX_ROOT_STEPS} top-level steps`);
  let total = 0;

  const walk = (list: unknown, path: string, depth: number): StepInput[] => {
    if (!Array.isArray(list)) throw badRequest(`${path} must be an array`);
    if (depth > MAX_DEPTH) throw badRequest(`${path}: conditions are nested too deeply (max ${MAX_DEPTH})`);
    return list.map((entry, i) => {
      const here = `${path}[${i}]`;
      if (!isObject(entry)) throw badRequest(`${here} must be an object`);
      total += 1;
      if (total > MAX_TOTAL_STEPS) throw badRequest(`An automation can have at most ${MAX_TOTAL_STEPS} steps in total`);
      for (const k of Object.keys(entry)) {
        if (!['step_type', 'step_config', 'branches'].includes(k)) throw badRequest(`${here}: unknown field '${k}'`);
      }
      if (typeof entry.step_type !== 'string' || !(AUTOMATION_STEP_TYPES as readonly string[]).includes(entry.step_type)) {
        if (entry.step_type === 'send_webhook') {
          throw badRequest(`${here}: 'send_webhook' steps can only be created in the dashboard`);
        }
        throw badRequest(`${here}.step_type must be one of: ${AUTOMATION_STEP_TYPES.join(', ')}`);
      }
      if (entry.step_config !== undefined && !isObject(entry.step_config)) {
        throw badRequest(`${here}.step_config must be an object`);
      }
      const out: StepInput = {
        step_type: entry.step_type,
        step_config: (entry.step_config as Record<string, unknown>) ?? {},
      };
      if (entry.branches !== undefined) {
        if (entry.step_type !== 'condition') throw badRequest(`${here}: only 'condition' steps have branches`);
        if (!isObject(entry.branches)) throw badRequest(`${here}.branches must be { yes: [...], no: [...] }`);
        for (const k of Object.keys(entry.branches)) {
          if (k !== 'yes' && k !== 'no') throw badRequest(`${here}.branches: unknown branch '${k}'`);
        }
        out.branches = {};
        if (entry.branches.yes !== undefined) out.branches.yes = walk(entry.branches.yes, `${here}.branches.yes`, depth + 1);
        if (entry.branches.no !== undefined) out.branches.no = walk(entry.branches.no, `${here}.branches.no`, depth + 1);
      }
      return out;
    });
  };
  return walk(raw, 'steps', 0);
}
