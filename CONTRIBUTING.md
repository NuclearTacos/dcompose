# Contributing

Thanks for looking. This is a small project with a clear shape; the fastest way to help is to
read `DESIGN.md` first, then pick something from the roadmap at the bottom of it.

## Setup

```sh
npm install
npm run dev -- --help        # runs src/cli.ts directly via Node's type stripping (Node >= 22.18)
npm run ci                   # typecheck, lint, format check, build, tests — same as GitHub Actions
```

To exercise the CLI against real servers, run `dcompose init --import-claude` in a scratch
directory that has MCP servers configured for Claude Code, or add entries to
`dcompose.local.json` by hand. That file is gitignored because it may carry secrets.

## Tests

`npm test` runs Node's built-in test runner over `test/**/*.test.ts`. Unit tests cover the pure
modules (result parsing, config merging, `pmap`, ULIDs, the type generator, the allow-list
matcher, the store). Integration tests spawn the CLI against a tiny in-repo MCP server at
`test/fixtures/echo-server.ts`, so they need no network and no credentials.

If you add a command or a context member, add a test that drives it through the CLI, not just
the function. The CLI's exit codes and stdout/stderr split are the contract agents depend on.

## Conventions

- stdout is data, stderr is everything else. Never print a log line to stdout.
- Exit codes: 0 ok, 1 script or tool error, 2 guardrail, 3 config or connection error.
- Expected failures print a one-line message. Unexpected ones print a stack trimmed to the
  user's frames. Do not print stacks for guardrail hits.
- TypeScript must stay within Node's erasable subset (`erasableSyntaxOnly` is on): no enums,
  no parameter properties, no namespaces in `src/`.
- Prettier and ESLint are enforced in CI. `npm run format` fixes formatting.

## Commits and PRs

Small, focused commits with a message that says why. Update `CHANGELOG.md` under
_Unreleased_ for anything user-visible. If you change the SKILL.md template in
`src/skill.ts`, regenerate the checked-in copies with `node src/cli.ts init --force`.
