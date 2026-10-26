// ============================================================
// A small declarative layer over server.registerTool.
//
// Every workspace-control tool is "validate arguments, call one API
// endpoint, return the JSON". Describing them as data keeps ~80 tools
// consistent: the same annotations per kind, the same `confirm` gate,
// the same error rendering. The wacrm API is the real authority (scopes,
// account scoping, validation); this layer only shapes what the model sees.
// ============================================================

import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorResult, handle, jsonResult } from './shared.js';

/** read: no side effects · write: changes data · destructive: deletes or cannot be undone. */
export type Kind = 'read' | 'write' | 'destructive';

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  kind: Kind;
  input?: ZodRawShape;
  /** Always require `confirm: true` (every delete). */
  confirm?: string;
  /** Require `confirm: true` only for some calls (e.g. activating an automation). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  confirmWhen?: (args: any) => string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => Promise<unknown>;
}

const CONFIRM = z
  .boolean()
  .describe('Set to true only after the user has approved this exact action.');

export function registerSpecs(server: McpServer, specs: ToolSpec[]): string[] {
  for (const spec of specs) {
    const shape: ZodRawShape = { ...(spec.input ?? {}) };
    if (spec.confirm) shape.confirm = CONFIRM;
    else if (spec.confirmWhen) shape.confirm = CONFIRM.optional();

    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: shape,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.kind === 'read',
          destructiveHint: spec.kind === 'destructive',
          // Retrying a read or a plain write is harmless to the outcome; a delete or
          // mass action is not something to repeat blindly.
          idempotentHint: spec.kind === 'read',
          openWorldHint: true,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle(async (args: any) => {
        const { confirm, ...rest } = args ?? {};
        const why = spec.confirm ?? spec.confirmWhen?.(rest) ?? null;
        if (why && confirm !== true) {
          return errorResult(
            `Refusing to run ${spec.name}: ${why} Describe it to the user, get their approval, then call again with confirm=true.`,
          );
        }
        return jsonResult(await spec.run(rest));
      }),
    );
  }
  return specs.map((s) => s.name);
}

// Shared argument pieces ------------------------------------------------

export const id = (what: string) => z.string().describe(`${what} id.`);

export const PAGE = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 50).'),
  cursor: z.string().optional().describe('Opaque pagination cursor from a previous response (next_cursor).'),
};

/** Drop undefined so optional arguments do not become empty query params. */
export const compact = <T extends Record<string, unknown>>(o: T): Record<string, string | number | undefined> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, string | number | undefined>;
