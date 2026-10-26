// ============================================================
// Delete tools — registered only when WACRM_ENABLE_DELETES (and
// WACRM_ENABLE_WRITES) are set, and every one needs confirm=true.
// Knowledge-base deletes also need AI admin; flow / automation deletes
// also need automations enabled, so no group can delete what it cannot edit.
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import type { Config } from '../config.js';
import { id, registerSpecs, type ToolSpec } from './dsl.js';

const enc = encodeURIComponent;

export function registerDeleteTools(server: McpServer, c: WacrmClient, config: Config): string[] {
  const del = (
    name: string,
    title: string,
    what: string,
    effect: string,
    input: z.ZodRawShape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- specs are heterogeneous; args are validated by each zod shape
    path: (a: any) => string,
  ): ToolSpec => ({
    name,
    title,
    description: `Delete ${what}. ${effect} This cannot be undone. Show the user exactly what will be deleted and get their approval first.`,
    kind: 'destructive',
    confirm: `this permanently deletes ${what}.`,
    input,
    run: (a) => c.delete(path(a)),
  });

  const specs: ToolSpec[] = [
    del('delete_contact', 'Delete a contact', 'a contact', 'Also deletes its conversations, messages, notes and tags; deals that pointed at it are kept without a contact.', { id: id('Contact') }, (a) => `/contacts/${enc(a.id)}`),
    del('delete_contact_note', 'Delete a contact note', 'a contact note', '', { contact_id: id('Contact'), note_id: id('Note') }, (a) => `/contacts/${enc(a.contact_id)}/notes/${enc(a.note_id)}`),
    del('delete_tag', 'Delete a tag', 'a tag', 'It is removed from every contact that has it.', { id: id('Tag') }, (a) => `/tags/${enc(a.id)}`),
    del('delete_custom_field', 'Delete a custom field', 'a custom contact field', 'Its values are removed from every contact.', { id: id('Custom field') }, (a) => `/custom-fields/${enc(a.id)}`),
    del('delete_quick_reply', 'Delete a quick reply', 'a quick reply', '', { id: id('Quick reply') }, (a) => `/quick-replies/${enc(a.id)}`),
    del('delete_pipeline', 'Delete a pipeline', 'a pipeline', 'Also deletes all its stages and the deals in it.', { id: id('Pipeline') }, (a) => `/pipelines/${enc(a.id)}`),
    del('delete_pipeline_stage', 'Delete a pipeline stage', 'a pipeline stage', 'Refused while deals are still in the stage.', { id: id('Stage') }, (a) => `/pipeline-stages/${enc(a.id)}`),
    del('delete_deal', 'Delete a deal', 'a deal', '', { id: id('Deal') }, (a) => `/deals/${enc(a.id)}`),
  ];
  if (config.enableAiAdmin) {
    specs.push(del('delete_knowledge_document', 'Delete a knowledge base document', 'a knowledge-base document', 'The AI agent can no longer use it to answer customers.', { id: id('Document') }, (a) => `/ai/knowledge/${enc(a.id)}`));
  }
  if (config.enableAutomations) {
    specs.push(
      del('delete_flow', 'Delete a flow', 'a flow', 'Also deletes its nodes and run history, and ends any chat currently in it.', { id: id('Flow') }, (a) => `/flows/${enc(a.id)}`),
      del('delete_automation', 'Delete an automation', 'an automation', 'Also deletes its steps and logs.', { id: id('Automation') }, (a) => `/automations/${enc(a.id)}`),
    );
  }
  return registerSpecs(server, specs);
}
