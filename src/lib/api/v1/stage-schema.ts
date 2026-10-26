import type { Schema } from '@/lib/api/v1/input';

export const STAGE_SCHEMA: Schema = {
  name: { type: 'string', required: true, max: 60 },
  color: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/, patternHint: 'a hex color like #3b82f6' },
  position: { type: 'int', min: 0, max: 1000 },
};
