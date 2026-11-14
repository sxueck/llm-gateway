# ast-grep rules (`rules/ast-grep-rules/`)

AST-level checks for this repo, run with [ast-grep](https://ast-grep.github.io)
(pinned as the `@ast-grep/cli` dev dependency; install with `bun install --frozen-lockfile`).

Two consumers:

- the CLI commands below, and the per-change exit check
  `ast-grep scan -c rules/ast-grep-rules/.sgconfig.yml <changed-file>`;
- pi-lens, which loads `<repo-root>/rules/ast-grep-rules/rules/*.yml`
  alongside its bundled rules (a project rule with the same `id` shadows the
  bundled one). Suppressions for that path use `// pi-lens-ignore: <id>` or
  `.pi-lens.json`.

## Layout

```text
.sgconfig.yml            ruleDirs: ./rules, testConfigs: ./rule-tests
rules/*.yml              the rules themselves
rule-tests/*-test.yml    behaviour fixtures, run by `ast-grep test`
```

## Rules

| id | language | severity | catches | gate |
| --- | --- | --- | --- | --- |
| `ts-syntax-error` | TypeScript | error | file does not parse (tree-sitter `ERROR` node) | yes — exit 1 |
| `js-syntax-error` | JavaScript | error | same, for the plain `.js` sources | yes — exit 1 |
| `esm-relative-specifier-ext` | TypeScript | warning | relative `import`/`export`/dynamic-`import` specifier without an allowed suffix | yes, in `ast:esm` (Node packages only) |
| `no-catch-swallow` | TypeScript | warning | `catch { return <fallback> }` / `catch { return; }` | no (advisory) |
| `parse-int-missing-radix` | TypeScript | warning | `parseInt` or `Number.parseInt` without an explicit radix | no (advisory) |
| `no-bare-hex-color-css` | CSS | warning | hex colors outside web token files | no (advisory) |
| `no-bare-hex-color-ts` | TypeScript | warning | hex color literals outside web token source and tests | no (advisory) |

`no-catch-swallow` is a verbatim vendored copy of the canonical rule in
`~/.pi/agent/rules/ast-grep-rules/` (that tree is the upstream; re-sync by
plain file copy). Its Python sibling `no-except-swallow` is not vendored: this
repo has no `.py` files. pi-lens's own `error-swallowing`, `error-obscuring`
and `missing-error-propagation` fact-rules cover the shapes this rule set
deliberately does not, so nothing here duplicates them.

## Commands

```bash
npm run ast            # packages/ + scripts/, all rules (only syntax errors fail)
npm run ast:syntax     # syntax gate on packages/ + scripts/
npm run ast:esm        # Node packages, ESM warnings promoted to errors
npm run ast:test       # rule fixtures: ast-grep test --skip-snapshot-tests
./node_modules/.bin/ast-grep scan -c rules/ast-grep-rules/.sgconfig.yml <changed-file>
```

Suppress one hit inline — on the same line as the violation or on the line
immediately before it (verified with 0.51, including multi-line import nodes):

```ts
import { format } from "./format"; // ast-grep-ignore: esm-relative-specifier-ext
```

For CSS, use `/* ast-grep-ignore: no-bare-hex-color-css */` on the same or previous line.

Use suppression only with a named requirement in the commit/PR — do not
reshape code to dodge a rule.

## Scope and CI

The build workflow runs `ast:test`, `ast:syntax` and `ast:esm` as gates.
Other warnings remain advisory and are visible through `npm run ast`.
`ast:esm` excludes `packages/web` on purpose: Vite-resolved extensionless
specifiers are the web convention. Scope is set by the command, not the rule.

## Limits

- No Vue parser in ast-grep 0.51, so `.vue` files are skipped entirely.
  `npm run ast` additionally runs `scripts/check-web-vue-hex.mjs`, a lexical
  advisory check for Vue color literals (excluding the Dashboard chart palette);
  it is not an AST parser. Test it with `node --test scripts/check-web-vue-hex.test.mjs`.
  `npm run typecheck` (tsc + vue-tsc) is the authority for them and for types
  everywhere else — a clean `ast:syntax` run is *not* proof that a file
  compiles.
- tree-sitter silently repairs some malformed code (`const t = { a: 1, b: 2 ;`,
  `function m(a, b {`, a trailing `let`): measured 10 of 16 breakage cases
  detected, 0 false positives on valid code. Details in `rules/*.yml` notes.
- `import(...)` in type position is whitelisted around the exact shapes this
  repo uses; see `rules/ts-syntax-error.yml`.
