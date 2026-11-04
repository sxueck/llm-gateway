import { describe, expect, it } from 'vitest'
import { isAdminUser } from '@/utils/role'

describe('isAdminUser', () => {
  it('grants admin UI only to an explicit admin role', () => {
    expect(isAdminUser({ role: 'admin' })).toBe(true)
    expect(isAdminUser({ role: 'user' })).toBe(false)
    expect(isAdminUser({ role: undefined })).toBe(false)
    expect(isAdminUser({ role: 'owner' as never })).toBe(false)
    expect(isAdminUser(null)).toBe(false)
  })
})
