import { describe, it, expect } from 'vitest'
import { IntlMessageFormat } from 'intl-messageformat'
import en from '../../../messages/en.json'
import es from '../../../messages/es.json'
import pt from '../../../messages/pt.json'
import ko from '../../../messages/ko.json'

// The Handoff tab shows strings containing literal {{placeholders}}. In
// ICU MessageFormat a bare `{` starts an argument, so they must be
// quoted ('{{'name'}}'); an unquoted one would throw when the tab renders.
const LOCALES = { en, es, pt, ko } as const

describe('Settings.aiHandoff strings', () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: every string formats, and placeholders come out literally`, () => {
      const group = messages.Settings.aiHandoff as Record<string, unknown>
      for (const [key, value] of Object.entries(group)) {
        if (typeof value !== 'string') continue
        const out = new IntlMessageFormat(value, locale).format({
          count: 5,
          max: 1000,
          zone: 'Asia/Kuala Lumpur',
        })
        expect(typeof out, key).toBe('string')
      }
      const out = new IntlMessageFormat(String(group.closedExample), locale).format()
      expect(out).toContain('{{next_open_day}}')
      expect(out).toContain('{{next_open_time}}')
    })

    it(`${locale}: has every English key (the old handoff keys are gone from aiConfig)`, () => {
      const keys = (o: unknown, p = ''): string[] =>
        Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
          v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`],
        )
      expect(keys(messages.Settings.aiHandoff).sort()).toEqual(keys(en.Settings.aiHandoff).sort())
      const aiConfig = messages.Settings.aiConfig as Record<string, unknown>
      expect(aiConfig).not.toHaveProperty('handoffTo')
      expect(aiConfig).not.toHaveProperty('handoffQueue')
    })
  }
})
