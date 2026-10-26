import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as resources from './resources';
import { AI_CONFIG_SELECT } from './ai';
import { PIPELINES } from './resources';
import { STAGE_SELECT } from './pipelines';
import type { ResourceConfig } from './crud';

// ---------------------------------------------------------------
// The routes build queries from column names that nothing type-checks
// (supabase-js is untyped here). This test reads the migrations and
// fails if any column the public API touches does not exist, so a typo
// or a renamed column cannot ship silently.
// ---------------------------------------------------------------

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const columns = new Map<string, Set<string>>();
const add = (table: string, col: string) => {
  const key = table.toLowerCase();
  if (!columns.has(key)) columns.set(key, new Set());
  columns.get(key)!.add(col.toLowerCase());
};

function loadSchema() {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '');
    // CREATE TABLE [IF NOT EXISTS] [public.]name ( ...columns... );
    for (const m of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi)) {
      for (const line of m[2].split('\n')) {
        const col = line.trim().match(/^"?(\w+)"?\s+[A-Za-z]/);
        if (col && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)$/i.test(col[1])) add(m[1], col[1]);
      }
    }
    // ALTER TABLE name ... ADD COLUMN [IF NOT EXISTS] col ...
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?(\w+)([\s\S]*?);/gi)) {
      for (const c of m[2].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/gi)) add(m[1], c[1]);
    }
  }
}
loadSchema();

const has = (table: string, col: string) => columns.get(table)?.has(col.toLowerCase()) ?? false;
const missing = (table: string, cols: string[]) => cols.filter((c) => !has(table, c));
const split = (select: string) => select.split(',').map((c) => c.trim()).filter(Boolean);

describe('migration parser sanity', () => {
  it('finds the core tables and columns', () => {
    expect(has('tags', 'name')).toBe(true);
    expect(has('tags', 'account_id')).toBe(true); // added by ALTER TABLE in 017
    expect(has('ai_configs', 'handoff_cap_message')).toBe(true); // added in 060
    expect(has('deals', 'assigned_to')).toBe(true);
    expect(has('tags', 'not_a_column')).toBe(false);
  });
});

describe('generic resources only use columns that exist', () => {
  const configs = Object.entries(resources).filter(
    (e): e is [string, ResourceConfig] => !!e[1] && typeof e[1] === 'object' && 'table' in (e[1] as object)
  );
  it('found the resource configs', () => expect(configs.length).toBeGreaterThanOrEqual(9));

  for (const [name, cfg] of configs) {
    it(`${name}: select, writable fields and keyset columns`, () => {
      const cols = split(cfg.select);
      expect(missing(cfg.table, cols), `select of ${cfg.table}`).toEqual([]);
      expect(missing(cfg.table, Object.keys(cfg.schema)), `writable fields of ${cfg.table}`).toEqual([]);
      expect(missing(cfg.table, Object.keys(cfg.filters ?? {})), `filters of ${cfg.table}`).toEqual([]);
      // list pagination and tenancy
      expect(cols).toContain('id');
      expect(cols).toContain('created_at');
      expect(has(cfg.table, 'account_id'), `${cfg.table}.account_id`).toBe(true);
      // never expose internals
      for (const hidden of ['account_id', 'user_id', 'api_key', 'access_token']) expect(cols).not.toContain(hidden);
      if (cfg.auditUserColumn) expect(has(cfg.table, cfg.auditUserColumn)).toBe(true);
    });
  }
});

describe('columns used by the hand-written routes exist', () => {
  const used: Record<string, string[]> = {
    ai_configs: [...split(AI_CONFIG_SELECT).filter((c) => !['updated_at'].includes(c) || true), 'account_id'],
    profiles: ['id', 'user_id', 'account_id', 'full_name', 'email', 'account_role', 'created_at'],
    pipeline_stages: split(STAGE_SELECT),
    pipelines: [...split(PIPELINES.select), 'account_id', 'user_id'],
    flow_nodes: ['id', 'flow_id', 'node_key', 'node_type', 'config', 'position_x', 'position_y', 'created_at'],
    flow_runs: ['id', 'flow_id', 'account_id', 'contact_id', 'status', 'current_node_key', 'started_at', 'last_advanced_at', 'ended_at', 'end_reason', 'reprompt_count'],
    flows: ['id', 'account_id', 'user_id', 'name', 'description', 'status', 'trigger_type', 'trigger_config', 'entry_node_id', 'fallback_policy', 'updated_at'],
    automations: ['id', 'account_id', 'user_id', 'name', 'description', 'trigger_type', 'trigger_config', 'is_active', 'updated_at'],
    automation_logs: ['id', 'automation_id', 'account_id', 'contact_id', 'trigger_event', 'steps_executed', 'status', 'error_message', 'created_at'],
    automation_steps: ['id', 'automation_id', 'parent_step_id', 'branch', 'step_type', 'step_config', 'position'],
    contact_notes: ['id', 'contact_id', 'account_id', 'user_id', 'note_text', 'created_at'],
    contact_custom_values: ['contact_id', 'custom_field_id', 'value'],
    custom_fields: ['id', 'account_id', 'field_name'],
    ai_knowledge_documents: ['id', 'account_id', 'created_by', 'title', 'content', 'created_at', 'updated_at'],
    conversations: ['id', 'account_id', 'status', 'assigned_agent_id', 'unread_count', 'ai_autoreply_disabled', 'ai_reply_count', 'ai_handoff_summary'],
    api_audit_log: ['id', 'account_id', 'api_key_id', 'action', 'resource_type', 'resource_id', 'summary', 'created_at'],
    deals: ['id', 'account_id', 'stage_id', 'pipeline_id'],
    message_templates: ['account_id', 'name', 'language'],
    contacts: ['id', 'account_id'],
  };
  for (const [table, cols] of Object.entries(used)) {
    it(table, () => expect(missing(table, cols)).toEqual([]));
  }
});
