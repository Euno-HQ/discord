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
