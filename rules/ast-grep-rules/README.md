# ast-grep rules (`rules/ast-grep-rules/`)

AST-level checks for this repo, run with [ast-grep](https://ast-grep.github.io)
(`ast-grep 0.51` or newer, installed on PATH — it is *not* an npm dependency).

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
| `esm-relative-specifier-ext` | TypeScript | warning | relative `import`/`export`/dynamic-`import` specifier without a `.js`/`.json` suffix | no (advisory) |
| `no-catch-swallow` | TypeScript | warning | `catch { return <fallback> }` / `catch { return; }` | no (advisory) |

`no-catch-swallow` is a verbatim vendored copy of the canonical rule in
`~/.pi/agent/rules/ast-grep-rules/` (that tree is the upstream; re-sync by
plain file copy). Its Python sibling `no-except-swallow` is not vendored: this
repo has no `.py` files. pi-lens's own `error-swallowing`, `error-obscuring`
and `missing-error-propagation` fact-rules cover the shapes this rule set
deliberately does not, so nothing here duplicates them.

## Commands

```bash
npm run ast            # whole tree, all rules (only syntax errors fail)
npm run ast:syntax     # the syntax gate on packages/ + scripts/
npm run ast:esm        # Node-run packages only (see scoping note)
npm run ast:test       # rule fixtures: ast-grep test --skip-snapshot-tests
ast-grep scan -c rules/ast-grep-rules/.sgconfig.yml <changed-file>   # exit check
```

Suppress one hit inline — on the same line as the violation or on the line
immediately before it (verified with 0.51, including multi-line import nodes):

```ts
import { format } from "./format"; // ast-grep-ignore: esm-relative-specifier-ext
```

Use suppression only with a named requirement in the commit/PR — do not
reshape code to dodge a rule.

## Known state of the tree (2025-11-01)

- `ast:syntax` — clean, 0 hits over `packages/` + `scripts/` (445 `.ts`).
- `ast:esm` — 1 hit: `packages/shared/src/utils/index.ts:1`
  (`export * from './protocol-types'`). Advisory until it is fixed.
- `no-catch-swallow` — 67 hits, mostly optional-config loaders. Backlog, not a
  gate; a new file should start at 0.
- `ast:esm` excludes `packages/web` on purpose: ast-grep rules cannot see the
  scanned file's path, and Vite-resolved extensionless specifiers are the web
  convention (16 further hits there, all correct).

## Limits

- No Vue parser in ast-grep 0.51, so `.vue` files are skipped entirely.
  `npm run typecheck` (tsc + vue-tsc) is the authority for them and for types
  everywhere else — a clean `ast:syntax` run is *not* proof that a file
  compiles.
- tree-sitter silently repairs some malformed code (`const t = { a: 1, b: 2 ;`,
  `function m(a, b {`, a trailing `let`): measured 10 of 16 breakage cases
  detected, 0 false positives on valid code. Details in `rules/*.yml` notes.
- `import(...)` in type position is whitelisted around the exact shapes this
  repo uses; see `rules/ts-syntax-error.yml`.
