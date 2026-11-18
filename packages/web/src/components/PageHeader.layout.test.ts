import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('./PageHeader.vue', import.meta.url), 'utf8')

describe('page header layout', () => {
  it('aligns actions right on wide screens and left when stacked', () => {
    expect(component).toMatch(/\.page-heading__actions\s*\{[^}]*justify-content:\s*flex-end/)
    expect(component).toMatch(/@media \(max-width: 700px\)\s*\{[\s\S]*?\.page-heading__actions\s*\{[^}]*justify-content:\s*flex-start/)
  })
})
