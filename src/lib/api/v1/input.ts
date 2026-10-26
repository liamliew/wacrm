// ============================================================
// Request-body validation for /api/v1 write endpoints.
//
// Strict on purpose: unknown fields are rejected (an LLM that misspells
// `system_prompt` should be told, not silently ignored), types are
// checked, and every message names the field. Errors are ApiErrors, so
// routes just let them propagate to `handler`.
// ============================================================

import { badRequest } from '@/lib/api/v1/respond';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuidString = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

/** Read the JSON body, which must be an object. */
export async function readBody(
  request: Request
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Like readBody, but an empty body means `{}` (for endpoints whose fields are all optional). */
export async function readOptionalBody(
  request: Request
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export type FieldSpec =
  | { type: 'string'; max?: number; min?: number; nullable?: boolean; trim?: boolean; required?: boolean; pattern?: RegExp; patternHint?: string }
  | { type: 'text'; max?: number; nullable?: boolean; required?: boolean } // long text, not trimmed
  | { type: 'int'; min?: number; max?: number; nullable?: boolean; required?: boolean }
  | { type: 'number'; min?: number; max?: number; nullable?: boolean; required?: boolean }
  | { type: 'bool'; required?: boolean }
  | { type: 'enum'; values: readonly string[]; nullable?: boolean; required?: boolean }
  | { type: 'uuid'; nullable?: boolean; required?: boolean }
  | { type: 'date'; nullable?: boolean; required?: boolean } // YYYY-MM-DD
  | { type: 'json'; nullable?: boolean; required?: boolean; check?: (v: unknown) => string | null };

export type Schema = Record<string, FieldSpec>;

function parseOne(name: string, spec: FieldSpec, value: unknown): unknown {
  if (value === null) {
    if ('nullable' in spec && spec.nullable) return null;
    throw badRequest(`'${name}' cannot be null`);
  }
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw badRequest(`'${name}' must be a string`);
      const v = spec.trim === false ? value : value.trim();
      if (v.length < (spec.min ?? (spec.required ? 1 : 0))) {
        throw badRequest(`'${name}' must not be empty`);
      }
      if (spec.max !== undefined && v.length > spec.max) {
        throw badRequest(`'${name}' must be at most ${spec.max} characters`);
      }
      if (spec.pattern && !spec.pattern.test(v)) {
        throw badRequest(`'${name}' must be ${spec.patternHint ?? 'in a valid format'}`);
      }
      return v;
    }
    case 'text': {
      if (typeof value !== 'string') throw badRequest(`'${name}' must be a string`);
      if (spec.required && value.trim() === '') throw badRequest(`'${name}' must not be empty`);
      if (spec.max !== undefined && value.length > spec.max) {
        throw badRequest(`'${name}' must be at most ${spec.max} characters`);
      }
      return value;
    }
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw badRequest(`'${name}' must be a number`);
      }
      if (spec.type === 'int' && !Number.isInteger(value)) {
        throw badRequest(`'${name}' must be a whole number`);
      }
      if (spec.min !== undefined && value < spec.min) throw badRequest(`'${name}' must be at least ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) throw badRequest(`'${name}' must be at most ${spec.max}`);
      return value;
    }
    case 'bool':
      if (typeof value !== 'boolean') throw badRequest(`'${name}' must be true or false`);
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw badRequest(`'${name}' must be one of: ${spec.values.join(', ')}`);
      }
      return value;
    case 'uuid':
      if (!isUuidString(value)) throw badRequest(`'${name}' must be an id (UUID)`);
      return value;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw badRequest(`'${name}' must be a date like 2026-12-31`);
      }
      return value;
    case 'json': {
      const problem = spec.check?.(value) ?? null;
      if (problem) throw badRequest(`'${name}': ${problem}`);
      return value;
    }
  }
}

/**
 * Validate `body` against `schema`. Unknown keys are rejected. With
 * `partial`, absent fields are skipped (PATCH); otherwise required ones
 * must be present (POST). Returns only the fields that were provided.
 */
export function parseBody(
  body: Record<string, unknown>,
  schema: Schema,
  opts: { partial: boolean; allowEmpty?: boolean }
): Record<string, unknown> {
  for (const key of Object.keys(body)) {
    if (!(key in schema)) {
      throw badRequest(
        `Unknown field '${key}'. Allowed: ${Object.keys(schema).join(', ')}`
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (!(name in body) || body[name] === undefined) {
      if (!opts.partial && spec.required) throw badRequest(`'${name}' is required`);
      continue;
    }
    out[name] = parseOne(name, spec, body[name]);
  }
  if (opts.partial && !opts.allowEmpty && Object.keys(out).length === 0) {
    throw badRequest('Nothing to update: send at least one field');
  }
  return out;
}
