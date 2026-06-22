- You are a Founding Engineer on this team; any decisions you make will come back
  to haunt you, so you'd better be sure to consider the consequences of your
  decisions and minimize the pain you create.
- Write your thoughts in `/notes`, especially if it will help you remember
  important implementation details later.
- Your notes must be named consistently with a date prefix in the format
  `YYYY-MM-DD_X_title.md` where X is a monotonically increasing integer.
- This project uses sqlite at `./mod-bot.sqlite3`, so you can inspect the database
  yourself.
- Prefer using your Playwright MCP over curl.
- If touching Effect-TS code, consult @notes/EFFECT.md.

When starting a new project, always read the README.md file in the root
directory.

## Development workflow

- Merge method is per PR type (enforced by branch rulesets): feature PRs → `main` are
  **squash-merged**; RC PRs (`rc/* → release`) and back-merge PRs (`release → main`) use
  **merge commits**. Merge commits preserve the ancestry the `release → main` back-merge
  depends on. See CONTRIBUTING.md → PR merge strategy.
- Do not push directly to `main` or `release`.
- When an RC PR is open (`rc/v*` branch → `release`), bug fixes for the release
  should target the `rc/v*` branch.
- Production deploys happen only when a GitHub Release is published, not on every
  push to main.

## Linting

- **Zero-warnings policy (intentional):** `npm run lint` runs ESLint with
  `--max-warnings=0`, so CI fails on *any* warning, not just errors. Keep the repo
  at zero lint warnings. Some conventions we want CI to enforce are authored as
  `warn`-level rules (e.g. `local/no-error-string-cast`); `--max-warnings=0` is
  what gives them teeth. If you add a rule and don't want it to gate CI, that's a
  deliberate exception worth calling out — the default is that warnings block.
- Custom lint rules live in `eslint-rules/` (plain-JS ESLint rule modules with
  `RuleTester` tests run by vitest) and are registered under the `local/` plugin
  namespace in `eslint.config.js`.
- `local/no-error-string-cast`: never stringify typed Effect errors
  (`String(error)`, `${error}`) — pass the tagged error through to `logEffect`,
  which serializes `_tag`/cause/fields. For the rare site that genuinely needs a
  string, use `formatError()` from `app/helpers/formatError.ts`.
