import type { Schema } from '@/lib/api/v1/input';

/** Bounds a single knowledge document: generous, but not unbounded. */
export const MAX_KNOWLEDGE_CHARS = 100_000;

export const KNOWLEDGE_SCHEMA: Schema = {
  title: { type: 'string', required: true, max: 200 },
  content: { type: 'text', required: true, max: MAX_KNOWLEDGE_CHARS },
};
