import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/v1/respond';
import { parseAutomationSteps, parseFlowNodes } from './flow-inputs';

const bad = (fn: () => unknown, text?: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    if (text) expect((e as ApiError).message).toContain(text);
    return;
  }
  throw new Error('expected a 400');
};

describe('parseFlowNodes', () => {
  const node = (over: Record<string, unknown> = {}) => ({ node_key: 'a', node_type: 'start', config: {}, ...over });

  it('accepts valid nodes and fills defaults', () => {
    expect(parseFlowNodes([node(), node({ node_key: 'b', node_type: 'end', position_x: 5 })])).toEqual([
      { node_key: 'a', node_type: 'start', config: {}, position_x: 0, position_y: 0 },
      { node_key: 'b', node_type: 'end', config: {}, position_x: 5, position_y: 0 },
    ]);
  });
  it('rejects bad shapes', () => {
    bad(() => parseFlowNodes('x'), 'array');
    bad(() => parseFlowNodes([1]), 'nodes[0]');
    bad(() => parseFlowNodes([node({ node_key: 'has space' })]), 'node_key');
    bad(() => parseFlowNodes([node({ node_type: 'teleport' })]), 'node_type');
    bad(() => parseFlowNodes([node({ config: 'x' })]), 'config');
    bad(() => parseFlowNodes([node({ position_x: 1.5 })]), 'position_x');
    bad(() => parseFlowNodes([node({ flow_id: 'x' })]), "unknown field 'flow_id'");
    bad(() => parseFlowNodes([node(), node()]), 'used twice');
    bad(() => parseFlowNodes(Array.from({ length: 201 }, (_, i) => node({ node_key: `n${i}` }))), 'at most');
  });
});

describe('parseAutomationSteps', () => {
  const step = (over: Record<string, unknown> = {}) => ({ step_type: 'send_message', step_config: { text: 'hi' }, ...over });

  it('accepts nested condition branches', () => {
    const out = parseAutomationSteps([
      step(),
      step({ step_type: 'condition', step_config: {}, branches: { yes: [step()], no: [step({ step_type: 'add_tag' })] } }),
    ]);
    expect(out[1].branches?.yes).toHaveLength(1);
    expect(out[1].branches?.no?.[0].step_type).toBe('add_tag');
  });
  it('rejects unknown types, fields, misplaced or malformed branches', () => {
    bad(() => parseAutomationSteps({}), 'array');
    bad(() => parseAutomationSteps([step({ step_type: 'hack' })]), 'step_type');
    bad(() => parseAutomationSteps([step({ step_config: 'x' })]), 'step_config');
    bad(() => parseAutomationSteps([step({ id: 'x' })]), "unknown field 'id'");
    bad(() => parseAutomationSteps([step({ branches: { yes: [] } })]), "only 'condition'");
    bad(() => parseAutomationSteps([step({ step_type: 'condition', branches: { maybe: [] } })]), "unknown branch 'maybe'");
    bad(() => parseAutomationSteps([step({ step_type: 'condition', branches: [] })]), 'branches');
  });
  it('bounds size and depth', () => {
    bad(() => parseAutomationSteps(Array.from({ length: 51 }, () => step())), 'top-level');
    let deep: unknown = [step()];
    for (let i = 0; i < 7; i++) deep = [step({ step_type: 'condition', branches: { yes: deep } })];
    bad(() => parseAutomationSteps(deep), 'nested too deeply');
    const many = Array.from({ length: 4 }, () => step({ step_type: 'condition', branches: { yes: Array.from({ length: 30 }, () => step()) } }));
    bad(() => parseAutomationSteps(many), 'at most 100');
  });
});

import { redactSteps } from './flow-inputs';

describe('send_webhook is dashboard-only', () => {
  it('refuses to create webhook steps, including inside branches', () => {
    bad(() => parseAutomationSteps([{ step_type: 'send_webhook', step_config: { url: 'https://evil.test' } }]), 'only be created in the dashboard');
    bad(
      () => parseAutomationSteps([{ step_type: 'condition', step_config: {}, branches: { yes: [{ step_type: 'send_webhook', step_config: {} }] } }]),
      'only be created in the dashboard'
    );
  });
  it('hides webhook headers and body templates (which may hold credentials) in anything returned', () => {
    const out = redactSteps([
      { step_type: 'send_webhook', step_config: { url: 'https://hook.test/x', headers: { Authorization: 'Bearer SECRET' }, body_template: '{"k":"SECRET"}' } },
      { step_type: 'condition', step_config: {}, branches: { yes: [{ step_type: 'send_webhook', step_config: { url: 'u', headers: { 'X-Key': 'SECRET' } } }], no: [] } },
      { step_type: 'send_message', step_config: { text: 'keep me' } },
    ]);
    const text = JSON.stringify(out);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('https://hook.test/x');
    expect(text).toContain('keep me');
  });
  it('passes non-arrays through untouched', () => {
    expect(redactSteps(null)).toBeNull();
  });
});
