import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandScale, contrastRatio, neutralScale } from './color-tokens';

const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');

describe('dashboard visual hierarchy', () => {
  it('uses a dark brand surface with readable primary-card text', () => {
    expect(css).toMatch(/\.dashboard-primary \.n-card\.stat-card-primary\s*\{[^}]*background:\s*var\(--color-brand-700\)/);
    expect(css).toMatch(/\.stat-card-primary \.stat-detail-value\s*\{[^}]*color:\s*var\(--color-neutral-0\)/);
    expect(contrastRatio(brandScale[700], neutralScale[0])).toBeGreaterThanOrEqual(4.5);
  });

  it('aligns dashboard actions right on wide layouts and left after stacking', () => {
    expect(css).toMatch(/\.dashboard-view :deep\(\.page-heading__actions\)\s*\{\s*justify-content:\s*flex-end/);
    expect(css).toMatch(/@media \(max-width: 700px\)\s*\{\s*\.dashboard-view :deep\(\.page-heading__actions\)\s*\{\s*justify-content:\s*flex-start/);
  });
});
