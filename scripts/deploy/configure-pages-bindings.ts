/**
 * Materializes `wrangler.jsonc` for a Pages deploy.
 *
 * Runs in `continuous-deployment.yml` before the Wrangler deploy. The template
 * carries `"service": "your-worker-service-name"`, which names no real backend,
 * so this script resolves the backend Worker service name and writes it in:
 *
 * 1. When `PROXY_TARGET_SERVICE` is set (non-empty), it always wins and no API
 *    call is made.
 * 2. When it is unset, the script lists the account's Worker scripts and, if
 *    exactly one non-Pages worker exists, uses it. Zero or multiple candidates
 *    fail the deploy so the placeholder can never reach production.
 *
 * Pages projects are excluded from auto-discovery: candidates come from the
 * Workers scripts endpoint (which never contains Pages), and any name that also
 * exists as a Pages project is additionally filtered out. The Pages listing is
 * best-effort: if it fails (e.g. the token lacks Pages read), discovery proceeds
 * on the scripts list alone with a warning, since that endpoint is Pages-free
 * by construction.
 *
 * Logging policy: error messages must never contain environment-derived values
 * (account id, tokens, configured names), so detail can be logged safely
 * (CodeQL clear-text logging). API-derived worker names and counts are fine.
 *
 * Requires Node 24+ (plain `node`, no transpiler: erasable syntax only).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TEMPLATE_PATH = 'wrangler.template.jsonc';
const OUTPUT_PATH = 'wrangler.jsonc';
const SERVICE_PLACEHOLDER = 'your-worker-service-name';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const PAGE_SIZE = 100;

interface CloudflareEnvelope {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  result_info?: { page?: number; total_pages?: number };
}

/** Trims the configured service name; blank and missing both mean "unset". */
export function normalizeConfigured(raw: string | undefined): string | undefined {
  const trimmed: string = raw?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Removes any script id that also exists as a Pages project name. A name living
 * in both namespaces is ambiguous as a deploy target, so it is never
 * auto-selected; set `PROXY_TARGET_SERVICE` explicitly instead.
 */
export function excludePagesScripts(scriptIds: string[], pagesNames: ReadonlySet<string>): string[] {
  return scriptIds.filter((id) => !pagesNames.has(id));
}

/**
 * Returns the single auto-discovery candidate, or throws telling the operator
 * to set `PROXY_TARGET_SERVICE`.
 */
export function selectSingleCandidate(candidates: string[]): string {
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new Error(
      'Auto-discovery found no Worker scripts (excluding Pages projects). ' +
        'Deploy the backend Worker first, or set the PROXY_TARGET_SERVICE repository variable explicitly.',
    );
  }
  throw new Error(
    `Auto-discovery found ${candidates.length} Worker scripts (${candidates.join(', ')}). ` +
      'Set the PROXY_TARGET_SERVICE repository variable to select the backend Worker service name.',
  );
}

/**
 * Writes the resolved service into the template placeholder. Throws when the
 * placeholder is absent (so a template edit can never silently deploy the
 * previous backend) or the service name is empty.
 */
export function renderWranglerConfig(template: string, service: string): string {
  const name: string = service.trim();
  if (name === '') {
    throw new Error('Refusing to render wrangler.jsonc with an empty backend service name.');
  }
  if (!template.includes(`"service": "${SERVICE_PLACEHOLDER}"`)) {
    throw new Error(
      `Template no longer contains the "${SERVICE_PLACEHOLDER}" placeholder; refusing to guess which service entry to patch.`,
    );
  }
  return template.replace(`"service": "${SERVICE_PLACEHOLDER}"`, `"service": "${name}"`);
}

function envelopeError(label: string, envelope: CloudflareEnvelope): Error {
  const detail: string = envelope.errors?.map((e) => e.message ?? String(e.code ?? '')).join('; ') || 'unknown error';
  return new Error(`Cloudflare API request failed for ${label}: ${detail}`);
}

/**
 * Fetches every page of a Cloudflare list endpoint, returning the picked string
 * per item. `pick` returns `undefined` for items without a usable name, which
 * are skipped rather than failing the whole listing. `label` is the static
 * endpoint name used in error messages; the URL (which carries the account id)
 * is never logged.
 */
export async function listAll(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  token: string,
  pick: (item: unknown) => string | undefined,
): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const response: Response = await fetchImpl(`${url}?page=${page}&per_page=${PAGE_SIZE}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Cloudflare API request failed for ${label} (page ${page}): HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as CloudflareEnvelope;
    if (!envelope.success) {
      throw envelopeError(label, envelope);
    }
    const items: unknown[] = Array.isArray(envelope.result) ? envelope.result : [];
    for (const item of items) {
      const name: string | undefined = pick(item);
      if (name !== undefined && name !== '') {
        names.push(name);
      }
    }
    const totalPages: number | undefined = envelope.result_info?.total_pages;
    if (totalPages !== undefined) {
      if (page >= totalPages) {
        return names;
      }
    } else if (items.length < PAGE_SIZE) {
      // No page count reported, so a short page is the only end-of-list signal.
      return names;
    }
    page += 1;
  }
}

function scriptId(item: unknown): string | undefined {
  if (typeof item === 'object' && item !== null && 'id' in item) {
    const id: unknown = (item as { id: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function pagesName(item: unknown): string | undefined {
  if (typeof item === 'object' && item !== null && 'name' in item) {
    const name: unknown = (item as { name: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

export interface Resolution {
  service: string;
  source: 'variable' | 'auto-discovery';
}

/** Resolves the backend service name without touching the filesystem. */
export async function resolveTargetService(options: {
  configured: string | undefined;
  fetchImpl: typeof fetch;
  accountId: string;
  token: string;
}): Promise<Resolution> {
  const fromVariable: string | undefined = normalizeConfigured(options.configured);
  if (fromVariable !== undefined) {
    return { service: fromVariable, source: 'variable' };
  }
  if (options.accountId === '' || options.token === '') {
    throw new Error(
      'PROXY_TARGET_SERVICE is unset and auto-discovery needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
    );
  }
  const scripts: string[] = await listAll(
    options.fetchImpl,
    `${API_BASE}/accounts/${options.accountId}/workers/scripts`,
    'workers/scripts',
    options.token,
    scriptId,
  );
  // Best-effort: the scripts endpoint is Pages-free by construction, so a Pages
  // listing failure only loses the overlap filter, never correctness of the set.
  let pages: string[] = [];
  try {
    pages = await listAll(
      options.fetchImpl,
      `${API_BASE}/accounts/${options.accountId}/pages/projects`,
      'pages/projects',
      options.token,
      pagesName,
    );
  } catch {
    console.warn('Warning: Pages project listing failed; auto-discovery proceeds on Worker scripts alone.');
  }
  return { service: selectSingleCandidate(excludePagesScripts(scripts, new Set(pages))), source: 'auto-discovery' };
}

async function main(): Promise<void> {
  const resolution: Resolution = await resolveTargetService({
    configured: process.env['PROXY_TARGET_SERVICE'],
    fetchImpl: fetch,
    accountId: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
    token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
  });
  const template: string = readFileSync(TEMPLATE_PATH, 'utf8');
  writeFileSync(OUTPUT_PATH, renderWranglerConfig(template, resolution.service));
  console.log(`Pages service bindings configured from ${resolution.source}.`);
}

const invokedDirectly: boolean =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Error text carries no environment-derived values by construction (see the
  // logging policy above), so logging the message is safe and keeps the
  // actionable cause — unset variable, zero or several workers, API failure —
  // visible in the deploy log.
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
