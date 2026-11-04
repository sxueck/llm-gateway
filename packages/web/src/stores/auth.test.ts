import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// vitest 跑在 node 环境，没有 localStorage；store 在模块初始化时就读快照，
// 所以先 stub 再动态 import，保证 stub 生效于 store 模块加载之前。
const storage = vi.hoisted(() => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map.entries()),
  }
})

const authApi = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  getProfile: vi.fn(),
}))

vi.mock('@/api/auth', () => ({ authApi }))

vi.stubGlobal('localStorage', storage)

const { useAuthStore } = await import('@/stores/auth')

beforeEach(() => {
  storage.clear()
  vi.clearAllMocks()
  setActivePinia(createPinia())
})

describe('auth store role handling', () => {
  it('exposes isAdmin=false for a normal user and persists a role snapshot', async () => {
    authApi.login.mockResolvedValue({
      token: 't1',
      user: { id: 'u1', username: 'alice', role: 'user' },
    })

    const store = useAuthStore()
    await store.login({ username: 'alice', password: 'x' })

    expect(store.isAdmin).toBe(false)
    expect(storage.dump().token).toBe('t1')
    expect(JSON.parse(storage.dump().authUser)).toEqual({
      id: 'u1',
      username: 'alice',
      role: 'user',
    })
  })

  it('does not grant admin access when the backend omits role', async () => {
    authApi.login.mockResolvedValue({
      token: 't2',
      user: { id: 'u2', username: 'root' },
    })

    const store = useAuthStore()
    await store.login({ username: 'root', password: 'x' })

    expect(store.isAdmin).toBe(false)
  })

  it('rehydrates the role from the stored snapshot on a fresh store (hard refresh)', async () => {
    authApi.login.mockResolvedValue({
      token: 't1',
      user: { id: 'u1', username: 'alice', role: 'user' },
    })
    await useAuthStore().login({ username: 'alice', password: 'x' })

    // 新 pinia 实例 = 新的 setup 执行路径，模拟刷新后重新读 localStorage
    setActivePinia(createPinia())
    const fresh = useAuthStore()

    expect(fresh.token).toBe('t1')
    expect(fresh.user?.username).toBe('alice')
    expect(fresh.isAdmin).toBe(false)
  })

  it('ensureProfileLoaded shares one in-flight profile request', async () => {
    storage.setItem('token', 't3')
    authApi.getProfile.mockResolvedValue({ id: 'u3', username: 'bob', role: 'user' })

    const store = useAuthStore()
    await Promise.all([store.ensureProfileLoaded(), store.ensureProfileLoaded()])

    expect(authApi.getProfile).toHaveBeenCalledTimes(1)
    expect(store.isAdmin).toBe(false)
    expect(JSON.parse(storage.dump().authUser).username).toBe('bob')
  })

  it('refreshes an existing session after promotion and demotion', async () => {
    storage.setItem('token', 't3')
    storage.setItem('authUser', JSON.stringify({ id: 'u3', username: 'bob', role: 'user' }))
    authApi.getProfile
      .mockResolvedValueOnce({ id: 'u3', username: 'bob', role: 'admin' })
      .mockResolvedValueOnce({ id: 'u3', username: 'bob', role: 'user' })

    const store = useAuthStore()
    await store.ensureProfileLoaded()
    expect(store.isAdmin).toBe(true)
    await store.ensureProfileLoaded()
    expect(store.isAdmin).toBe(false)
    expect(JSON.parse(storage.dump().authUser).role).toBe('user')
  })

  it('does not restore a profile after logout while the request is in flight', async () => {
    storage.setItem('token', 't3')
    let resolveProfile!: (user: { id: string; username: string; role: 'admin' }) => void
    authApi.getProfile.mockReturnValue(new Promise(resolve => { resolveProfile = resolve }))
    const store = useAuthStore()
    const pending = store.ensureProfileLoaded()
    store.logout()
    resolveProfile({ id: 'u3', username: 'bob', role: 'admin' })
    await pending
    expect(store.user).toBeNull()
    expect(storage.dump().authUser).toBeUndefined()
  })

  it('logout clears both token and user snapshot', async () => {
    authApi.login.mockResolvedValue({
      token: 't1',
      user: { id: 'u1', username: 'alice', role: 'user' },
    })
    const store = useAuthStore()
    await store.login({ username: 'alice', password: 'x' })

    store.logout()

    expect(store.token).toBeNull()
    expect(store.user).toBeNull()
    expect(storage.dump().token).toBeUndefined()
    expect(storage.dump().authUser).toBeUndefined()
  })
})
