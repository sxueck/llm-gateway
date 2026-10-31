import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), go: vi.fn() }) }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('naive-ui', () => ({ NInput: defineComponent({ render: () => h('input') }) }));
vi.mock('@/composables/useNavigation', () => ({
  useNavigation: () => ({
    pages: { value: [
      { path: '/first', label: 'First', iconName: 'search' },
      { path: '/second', label: 'Second', iconName: 'search' },
      ...Array.from({ length: 8 }, (_, index) => ({
        path: `/extra-${index}`, label: `Extra ${index}`, iconName: 'search',
      })),
    ] },
  }),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ logout: vi.fn() }) }));

import CommandPalette from './CommandPalette.vue';

type Node = { children: Node[]; parent?: Node };
const renderer = createRenderer<Node, Node>({
  createElement: () => ({ children: [] }),
  createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }),
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  insert: (el, parent) => { el.parent = parent; parent.children.push(el); },
  remove: () => {},
  parentNode: (el) => el.parent ?? null,
  nextSibling: () => null,
});

afterEach(() => vi.unstubAllGlobals());

describe('command palette highlight', () => {
  it('tracks keyboard selection and filtering, and hides when no result matches', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { body: { style: {} } });
    CommandPalette.render = () => null;
    const app = renderer.createApp(CommandPalette);
    app.provide(ssrContextKey, { modules: new Set() });
    app.mount({ children: [] });
    const state = (app as any)._instance.setupState;
    expect(state.flatEntries).toHaveLength(8);
    expect(state.flatEntries.every((entry: { id: string }) => !entry.id.startsWith('action:'))).toBe(true);
    state.query = 'extra';
    expect(state.flatEntries).toHaveLength(8);
    expect(state.flatEntries.some((entry: { id: string }) => entry.id === '/extra-7')).toBe(true);
    state.query = 'refresh';
    expect(state.flatEntries.map((entry: { id: string }) => entry.id)).toEqual(['action:refresh']);
    state.query = '';
    const scrollIntoView = vi.fn();
    let selected: { offsetTop: number; offsetHeight: number; scrollIntoView: typeof scrollIntoView } | null = {
      offsetTop: 28, offsetHeight: 36, scrollIntoView,
    };
    state.listRef = { querySelector: () => selected };
    state.visible = true;
    await nextTick();
    await nextTick();
    expect(state.highlightStyle).toEqual({ opacity: 1, transform: 'translateY(28px)', height: '36px' });

    selected = { offsetTop: 64, offsetHeight: 38, scrollIntoView };
    state.move(1);
    await nextTick();
    await nextTick();
    expect(state.highlightStyle).toEqual({ opacity: 1, transform: 'translateY(64px)', height: '38px' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

    selected = { offsetTop: 28, offsetHeight: 36, scrollIntoView };
    state.query = 'second';
    await nextTick();
    await nextTick();
    expect(state.activeEntry.id).toBe('/second');
    expect(state.highlightStyle.transform).toBe('translateY(28px)');

    selected = null;
    state.query = 'no matching entry';
    await nextTick();
    await nextTick();
    expect(state.highlightStyle.opacity).toBe(0);
    app.unmount();
  });
});
