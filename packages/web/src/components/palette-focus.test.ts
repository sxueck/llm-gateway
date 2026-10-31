import { afterEach, describe, expect, it, vi } from 'vitest';
import { trapPaletteFocus } from './palette-focus';

afterEach(() => vi.unstubAllGlobals());

describe('trapPaletteFocus', () => {
  it.each([
    { shiftKey: false, active: 'last', target: 'first' },
    { shiftKey: true, active: 'first', target: 'last' },
  ] as const)('wraps focus from $active to $target', ({ shiftKey, active, target }) => {
    const first = { offsetParent: {}, hasAttribute: () => false, focus: vi.fn() };
    const last = { offsetParent: {}, hasAttribute: () => false, focus: vi.fn() };
    const elements = { first, last };
    vi.stubGlobal('document', { activeElement: elements[active] });
    const dialog = { querySelectorAll: () => [first, last] } as unknown as HTMLElement;
    const preventDefault = vi.fn();
    trapPaletteFocus({ key: 'Tab', shiftKey, preventDefault } as unknown as KeyboardEvent, dialog);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(elements[target].focus).toHaveBeenCalledOnce();
  });

  it('leaves ordinary Tab navigation alone', () => {
    const first = { offsetParent: {}, hasAttribute: () => false, focus: vi.fn() };
    const last = { offsetParent: {}, hasAttribute: () => false, focus: vi.fn() };
    vi.stubGlobal('document', { activeElement: first });
    const dialog = { querySelectorAll: () => [first, last] } as unknown as HTMLElement;
    const preventDefault = vi.fn();
    trapPaletteFocus({ key: 'Tab', shiftKey: false, preventDefault } as unknown as KeyboardEvent, dialog);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(last.focus).not.toHaveBeenCalled();
  });
});
