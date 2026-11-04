import type { User } from '@/types'

export function isAdminUser(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'admin'
}
