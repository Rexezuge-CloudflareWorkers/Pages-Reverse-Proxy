# AGENTS.md

Guidance for agents working in Pages-Reverse-Proxy.

## Overview

Minimal Cloudflare Pages project whose catch-all function (`functions/[[path]].ts`) reverse-proxies every non-asset request to a Cloudflare Worker selected by configuration:

- Env var `PROXY_TARGET_BINDING` names the service binding to use (default `API_WORKER`).
- Bindings are declared in `wrangler.jsonc` (copied from `wrangler.template.jsonc`, gitignored).
- Static assets in `public/` are served by Pages directly, bypassing the proxy.
- Missing/unsupported binding → `502` plain-text response.

Proxy behavior: preserves original URL; sets `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Uri`; maps `CF-Connecting-IP` → `X-Forwarded-For` when present; forwards request body (streamed) for non-GET/HEAD methods; passes `redirect: 'follow'` through.

## Commands

Always source toolchain before any Node/pnpm/npm/npx/Wrangler command:

```bash
source ~/.customrc
volta run pnpm install
volta run pnpm run typecheck
volta run pnpm run lint
volta run pnpm run test
volta run pnpm run typegen   # regenerates worker-configuration.d.ts (gitignored)
```

| Command | Purpose |
|---|---|
| `volta run npx wrangler pages deploy --project-name <name>` | Deploy to Cloudflare Pages |
| `volta run npx wrangler types --config wrangler.template.jsonc` | Generate TS types |

The `postinstall` script runs `wrangler types` automatically, so `worker-configuration.d.ts` (which provides global `PagesFunction` and `Fetcher` types) exists after install.

## Architecture

- `functions/[[path]].ts` — the entire proxy; exports `proxyToTarget` and `onRequest`. One `PagesFunction`; no build step, no src tree.
- `test/proxy.test.ts` — Vitest unit tests for binding resolution, header forwarding, body forwarding, and error responses.
- `public/` — placeholder Pages asset directory (empty except `.gitkeep`).
- `wrangler.template.jsonc` — Pages config template; copy to `wrangler.jsonc` per deployer; no committed `wrangler.jsonc`.
- `.github/dependabot.yml` — weekly npm updates (mirrors Otter).
- `.github/actions/retry-step/` — shared retry wrapper for flaky commands (mirrors Otter).
- `.github/actions/setup-env/` — shared pnpm + Node 24 + cached `pnpm install` with retry (mirrors Otter).

## Conventions

- ESLint (typescript-eslint recommended + prettier) and Prettier (140 col, single quotes) match the Mail-Otter repo conventions this was extracted from.
- Keep `PROXY_TARGET_BINDING` the only runtime knob. Any new power should stay config-driven, not code edits.
- CI (lint/typecheck/test) runs on every push/PR with concurrency cancel-in-progress; Dependabot PRs auto-merge via `gh pr merge --auto --merge` once `verify` passes (requires `Allow auto-merge` repo setting); CD deploys Pages on `main` using secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` and variable `CLOUDFLARE_PAGES_PROJECT_NAME`, with `retry-step` around installs and deploys.

## Cloudflare Documentation

APIs, limits, and behavior change frequently. Before any Pages, Workers, or service binding task, retrieve current official docs:

- Workers: https://developers.cloudflare.com/workers/
- Pages: https://developers.cloudflare.com/pages/
- Pages functions: https://developers.cloudflare.com/pages/functions/
- Limits: retrieve `/platform/limits/` pages per product

## Keeping AGENTS.md Current

Update this file as part of any change that adds, removes, or renames config knobs, headers, workflows, or test files.

## Commit Policy

Always commit changes after completing work unless explicitly told not to.

### Git Commit Messages

Format: `<TYPE>[optional scope]: <description>`

- Type in UPPERCASE: `FIX`, `FEAT`, `DOCS`, `STYLE`, `REFACTOR`, `TEST`, `BUILD`, `CHORE`, `CI`, `PERF`.
- Scope in lowercase: `FEAT(runtime): Add Scheduled Job State`.
- Description: Title Case words — `DOCS: Latest Agents Context Reflection`.
- When committing from `main`, first create a branch: `type/description` or `type/scope/description` in kebab-case.
- Always include a Markdown body separated from the subject by a blank line.
- Breaking changes: `!` after type/scope, or `BREAKING CHANGE: <description>` footer.

```text
<TYPE>[optional scope]: <description>

[Markdown body]

[optional footers]
```