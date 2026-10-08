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
 * exists as a Pages project is additionally filtered out.
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
        'Set the PROXY_TARGET_SERVICE repository variable to the backend Worker service name.',
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

function envelopeError(url: string, envelope: CloudflareEnvelope): Error {
  const detail: string = envelope.errors?.map((e) => e.message ?? String(e.code ?? '')).join('; ') || 'unknown error';
  return new Error(`Cloudflare API request failed: GET ${url}: ${detail}`);
}

/**
 * Fetches every page of a Cloudflare list endpoint, returning the picked string
 * per item. `pick` returns `undefined` for items without a usable name, which
 * are skipped rather than failing the whole listing.
 */
export async function listAll(
  fetchImpl: typeof fetch,
  url: string,
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
      throw new Error(`Cloudflare API request failed: GET ${url} (page ${page}): HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as CloudflareEnvelope;
    if (!envelope.success) {
      throw envelopeError(url, envelope);
    }
    const items: unknown[] = Array.isArray(envelope.result) ? envelope.result : [];
    for (const item of items) {
      const name: string | undefined = pick(item);
      if (name !== undefined && name !== '') {
        names.push(name);
      }
    }
    const totalPages: number | undefined = envelope.result_info?.total_pages;
    if ((totalPages !== undefined && page >= totalPages) || items.length < PAGE_SIZE) {
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
    options.token,
    scriptId,
  );
  const pages: string[] = await listAll(
    options.fetchImpl,
    `${API_BASE}/accounts/${options.accountId}/pages/projects`,
    options.token,
    pagesName,
  );
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
  console.log(`Backend Worker service "${resolution.service}" configured from ${resolution.source}.`);
}

const invokedDirectly: boolean =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
