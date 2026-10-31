import { createRenderer, nextTick, ssrContextKey } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ login: vi.fn(), push: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ login: mocks.login }) }))
vi.mock('@/composables/useSystemConfig', () => ({ useSystemConfig: () => ({ allowRegistration: false }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: mocks.success, error: mocks.error }),
  NForm: {}, NFormItem: {}, NInput: {}, NButton: {}, NSpace: {}, NIcon: {},
}))

import LoginView from './LoginView.vue'

type Node = { children: Node[], parent?: Node }
const renderer = createRenderer<Node, Node>({
  createElement: () => ({ children: [] }), createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }), setText: () => {}, setElementText: () => {},
  patchProp: () => {}, insert: (el, parent) => { el.parent = parent; parent.children.push(el) },
  remove: () => {}, parentNode: el => el.parent ?? null, nextSibling: () => null,
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('login success transition', () => {
  it('shows success before navigating and rejects duplicate submissions', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, matchMedia: () => ({ matches: false }) })
    mocks.login.mockResolvedValue(undefined)
    mocks.push.mockResolvedValue(undefined)
    LoginView.render = () => null
    const app = renderer.createApp(LoginView)
    app.provide(ssrContextKey, { modules: new Set() })
    app.mount({ children: [] })
    const state = (app as any)._instance.setupState
    state.formRef = { validate: vi.fn().mockResolvedValue(undefined) }
    const pending = state.handleLogin()
    await vi.waitFor(() => expect(state.loginSucceeded).toBe(true))
    await state.handleLogin()
    expect(mocks.login).toHaveBeenCalledTimes(1)
    expect(mocks.push).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(360)
    await pending
    await nextTick()
    expect(mocks.push).toHaveBeenCalledWith('/dashboard')
    app.unmount()
  })
})
