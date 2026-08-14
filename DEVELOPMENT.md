# Development

## Prerequisites

Install tools via mise:

```powershell
mise install
```

This installs `hk` (git hooks), `communique` (release notes), and `node`
as pinned in `mise.toml`.

## Daily workflow

### Committing

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
format — enforced by hk's `commit-msg` hook:

```
feat: add dark mode toggle
fix: correct export filename on Windows
chore: update dependencies
docs: improve README
refactor: extract UI library
```

Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, `test`.

Bypass with `HK=0 git commit -m "..."` if needed.

### Building

```powershell
npm run build     # assembles src/ → dist/gemini-conversation-exporter.user.js
npm test          # runs all tests (node --test)
npm run check     # test + build in one command
```

### Releasing

```powershell
npm run release              # auto-detect bump level from commits
npm run release -- patch     # force patch
npm run release -- minor     # force minor
npm run release -- major     # force major
```

The release script:
1. Checks working tree is clean and on `main`
2. Detects semver bump from conventional commits since last tag
   (`feat:` → minor, `fix:`/`chore:` → patch, `BREAKING CHANGE` → major)
3. Bumps `package.json` version
4. Builds and tests
5. Generates changelog via communique (OpenRouter + Gemini 3.7 Flash)
6. Updates `CHANGELOG.md`
7. Commits, tags `vX.Y.Z`, pushes

### Publishing a GitHub release

After `npm run release` pushes the tag:

```powershell
$env:OPENAI_API_KEY = $env:OPENROUTER_API_KEY
mise x -- communique generate vX.Y.Z --github-release
```

## Project structure

```
src/
  core.js                  — conversation parsing, markdown rendering
  exporter-ui.css          — Shadow DOM styles (inlined at build time)
  history-fetcher.js       — paginated Gemini history API client
  preference-storage.js    — Tampermonkey GM_getValue/GM_setValue wrappers
  ui.js                    — reusable Shadow DOM UI builders
  userscript-main.js       — Gemini-specific wiring + export logic
  userscript-metadata.js   — UserScript header generation from package.json
  utils.js                 — shared helpers (download, cloneForPageRealm)
scripts/
  build.js                 — assembles modules into single .user.js
  release.js               — version bump + changelog + tag + push
test/                      — node --test suites (81 tests)
dist/                      — built output (committed)
```

## Configuration files

| File | Purpose |
|------|---------|
| `mise.toml` | Pins hk, communique, node versions |
| `hk.pkl` | Enforces conventional commits via commit-msg hook |
| `communique.toml` | AI release notes via OpenRouter |
| `package.json` | `userscript` section drives metadata generation |
