# Pages-Reverse-Proxy

A minimal Cloudflare Pages project that reverse-proxies every non-asset request to any Cloudflare Worker (or other Pages project) configured via a service binding. The target worker is selected **by configuration** — no code changes needed to point the proxy at a different worker.

Static files placed in `public/` are served directly by Pages; everything else is forwarded to the configured target with standard `X-Forwarded-*` headers.

## How It Works

- `functions/[[path]].ts` is the Pages Functions catch-all.
- The env var `PROXY_TARGET_BINDING` names the service binding to use (default `API_WORKER` when unset).
- The binding must be declared in `wrangler.jsonc` as a service binding — declare as many workers as you like and pick one at runtime.

## Configure

1. Copy the template and fill in the target worker's service name:

   ```bash
   cp wrangler.template.jsonc wrangler.jsonc
   ```

   ```jsonc
   {
     "name": "pages-reverse-proxy",
     "pages_build_output_dir": "public/",
     "services": [
       {
         "binding": "API_WORKER",
         "service": "my-api-worker", // any deployed Worker service name
       },
     ],
     "vars": {
       "PROXY_TARGET_BINDING": "API_WORKER",
     },
   }
   ```

2. To target a different worker, add another binding and change the var:

   ```jsonc
   "services": [
     { "binding": "API_WORKER", "service": "my-api-worker" },
     { "binding": "OTHER_WORKER", "service": "my-other-worker" },
   ],
   "vars": { "PROXY_TARGET_BINDING": "OTHER_WORKER" }
   ```

   Or drop the `vars` entry entirely to use the default `API_WORKER` binding.

## Deploy

```bash
source ~/.customrc
volta run pnpm install
volta run npx wrangler pages deploy --project-name "<pages-project-name>"
```

`wrangler.jsonc` is gitignored — each deployer supplies their own copy.

## Forwarded Headers

| Header              | Source                      |
| ------------------- | --------------------------- |
| `X-Forwarded-Host`  | Original request host       |
| `X-Forwarded-Proto` | Original request protocol   |
| `X-Forwarded-Uri`   | Original pathname + search  |
| `X-Forwarded-For`   | `CF-Connecting-IP` (if set) |

Responses from the target are returned unchanged. An unconfigured binding yields `502` with a plain-text explanation.

## Local Commands

| Command                 | Purpose                          |
| ----------------------- | -------------------------------- |
| `volta run pnpm install` | Install deps + generate types   |
| `volta run pnpm run typecheck` | TypeScript check               |
| `volta run pnpm run lint` | ESLint                          |
| `volta run pnpm run test` | Vitest unit tests               |
| `volta run pnpm run typegen` | Regenerate `worker-configuration.d.ts` |

## CI/CD

- **CI**: lint + typecheck + tests on every push and pull request. Dependabot PRs (npm, weekly) auto-merge once `verify` passes. Flaky setup uses the shared `setup-env` / `retry-step` actions.
- **CD**: deploys to Cloudflare Pages on `main` with `retry-step` around the Wrangler deploy. Set the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the variable `CLOUDFLARE_PAGES_PROJECT_NAME`. Enable `Allow auto-merge` in repository settings for Dependabot auto-merge.