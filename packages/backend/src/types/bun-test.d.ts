// Minimal Bun test type shim for `tsc --noEmit`.
// We intentionally keep this lightweight to avoid pulling in extra dev dependencies.

declare module 'bun:test' {
  export const describe: any;
  export const it: any;
  export const test: any;
  export const expect: any;
  export const beforeAll: any;
  export const afterAll: any;
  export const beforeEach: any;
  export const afterEach: any;
}
