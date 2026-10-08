import { describe, expect, it, vi } from 'vitest';
import {
  excludePagesScripts,
  listAll,
  normalizeConfigured,
  renderWranglerConfig,
  resolveTargetService,
  selectSingleCandidate,
} from '../scripts/deploy/configure-pages-bindings';

const TEMPLATE = `{
  "services": [
    {
      "binding": "PROXY_TARGET",
      "service": "your-worker-service-name",
    },
  ],
}`;

function envelope(result: unknown[]): Record<string, unknown> {
  return { success: true, errors: [], messages: [], result, result_info: { page: 1, total_pages: 1 } };
}

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: unknown) => {
    const url: string = String(input).split('?')[0] ?? '';
    const body: unknown = routes[url];
    if (body === undefined) {
      throw new Error(`Unexpected request URL: ${String(input)}`);
    }
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

const SCRIPTS_URL = 'https://api.cloudflare.com/client/v4/accounts/test-account/workers/scripts';
const PAGES_URL = 'https://api.cloudflare.com/client/v4/accounts/test-account/pages/projects';

describe('normalizeConfigured', () => {
  it('returns the trimmed service name when set', () => {
    expect(normalizeConfigured('my-worker')).toBe('my-worker');
    expect(normalizeConfigured('  my-worker  ')).toBe('my-worker');
  });

  it('treats missing and blank values as unset', () => {
    expect(normalizeConfigured(undefined)).toBeUndefined();
    expect(normalizeConfigured('')).toBeUndefined();
    expect(normalizeConfigured('   ')).toBeUndefined();
  });
});

describe('excludePagesScripts', () => {
  it('removes script ids that also exist as Pages projects', () => {
    expect(excludePagesScripts(['api', 'site'], new Set(['site']))).toEqual(['api']);
  });

  it('keeps every script when nothing overlaps', () => {
    expect(excludePagesScripts(['api'], new Set())).toEqual(['api']);
  });
});

describe('selectSingleCandidate', () => {
  it('returns the only candidate', () => {
    expect(selectSingleCandidate(['only-worker'])).toBe('only-worker');
  });

  it('throws naming PROXY_TARGET_SERVICE when no candidates exist', () => {
    expect(() => selectSingleCandidate([])).toThrow(/PROXY_TARGET_SERVICE/);
  });

  it('throws listing the candidates when several exist', () => {
    expect(() => selectSingleCandidate(['one', 'two'])).toThrow(/one.*two|two.*one/);
    expect(() => selectSingleCandidate(['one', 'two'])).toThrow(/PROXY_TARGET_SERVICE/);
  });
});

describe('renderWranglerConfig', () => {
  it('replaces the placeholder with the resolved service', () => {
    const rendered: string = renderWranglerConfig(TEMPLATE, 'my-api-worker');
    expect(rendered).toContain('"service": "my-api-worker"');
    expect(rendered).not.toContain('your-worker-service-name');
    expect(rendered).toContain('"binding": "PROXY_TARGET"');
  });

  it('throws when the template no longer contains the placeholder', () => {
    expect(() => renderWranglerConfig('{"services": []}', 'my-api-worker')).toThrow(/placeholder/);
  });

  it('throws on an empty service name', () => {
    expect(() => renderWranglerConfig(TEMPLATE, '   ')).toThrow(/empty/);
  });
});

describe('listAll', () => {
  it('collects ids across pages', async () => {
    const fetchImpl = (async (input: unknown) => {
      const url: string = String(input);
      const page: number = Number(new URL(url).searchParams.get('page'));
      const result: unknown[] = page === 1 ? [{ id: 'a' }, { nope: true }, { id: 'b' }] : [{ id: 'c' }];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result,
          result_info: { page, total_pages: 2 },
        }),
      };
    }) as unknown as typeof fetch;
    const pick = (item: unknown): string | undefined =>
      typeof item === 'object' && item !== null && 'id' in item && typeof (item as { id: unknown }).id === 'string'
        ? (item as { id: string }).id
        : undefined;
    expect(await listAll(fetchImpl, 'https://example.test/items', 'items', 'token', pick)).toEqual(['a', 'b', 'c']);
  });

  it('throws on an unsuccessful envelope', async () => {
    const failing = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, errors: [{ message: 'boom' }] }),
    })) as unknown as typeof fetch;
    await expect(listAll(failing, 'https://example.test/items', 'items', 'token', () => 'x')).rejects.toThrow(/boom/);
  });

  it('throws on a non-OK HTTP status', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(listAll(fetchImpl, 'https://example.test/items', 'items', 'token', () => 'x')).rejects.toThrow(
      /403/,
    );
  });

  it('keeps environment-derived values out of error messages', async () => {
    const failing = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, errors: [{ message: 'boom' }] }),
    })) as unknown as typeof fetch;
    const error = await listAll(failing, 'https://example.test/items', 'items', 's3cr3t', () => 'x').catch(
      (e: unknown) => e,
    );
    expect(String((error as Error).message)).not.toContain('s3cr3t');
  });
});

describe('resolveTargetService', () => {
  it('uses the configured variable without calling the API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolution = await resolveTargetService({
      configured: '  pinned-worker ',
      fetchImpl,
      accountId: 'test-account',
      token: 'token',
    });
    expect(resolution).toEqual({ service: 'pinned-worker', source: 'variable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('auto-discovers the only non-Pages worker', async () => {
    const fetchImpl = stubFetch({
      [SCRIPTS_URL]: envelope([{ id: 'only-worker' }]),
      [PAGES_URL]: envelope([]),
    });
    const resolution = await resolveTargetService({
      configured: undefined,
      fetchImpl,
      accountId: 'test-account',
      token: 'token',
    });
    expect(resolution).toEqual({ service: 'only-worker', source: 'auto-discovery' });
  });

  it('excludes Pages projects from auto-discovery', async () => {
    const fetchImpl = stubFetch({
      [SCRIPTS_URL]: envelope([{ id: 'api' }, { id: 'site' }]),
      [PAGES_URL]: envelope([{ name: 'site' }]),
    });
    const resolution = await resolveTargetService({
      configured: undefined,
      fetchImpl,
      accountId: 'test-account',
      token: 'token',
    });
    expect(resolution.service).toBe('api');
  });

  it('proceeds on Worker scripts alone when the Pages listing fails', async () => {
    const fetchImpl = (async (input: unknown) => {
      const url: string = String(input).split('?')[0] ?? '';
      if (url === PAGES_URL) {
        return { ok: false, status: 403 };
      }
      return { ok: true, status: 200, json: async () => envelope([{ id: 'only-worker' }]) };
    }) as unknown as typeof fetch;
    const resolution = await resolveTargetService({
      configured: undefined,
      fetchImpl,
      accountId: 'test-account',
      token: 'token',
    });
    expect(resolution).toEqual({ service: 'only-worker', source: 'auto-discovery' });
  });

  it('fails when discovery finds no workers', async () => {
    const fetchImpl = stubFetch({ [SCRIPTS_URL]: envelope([]), [PAGES_URL]: envelope([]) });
    await expect(
      resolveTargetService({ configured: undefined, fetchImpl, accountId: 'test-account', token: 'token' }),
    ).rejects.toThrow(/PROXY_TARGET_SERVICE/);
  });

  it('fails when discovery finds several workers', async () => {
    const fetchImpl = stubFetch({
      [SCRIPTS_URL]: envelope([{ id: 'one' }, { id: 'two' }]),
      [PAGES_URL]: envelope([]),
    });
    await expect(
      resolveTargetService({ configured: undefined, fetchImpl, accountId: 'test-account', token: 'token' }),
    ).rejects.toThrow(/PROXY_TARGET_SERVICE/);
  });

  it('fails when credentials are missing and no variable is set', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      resolveTargetService({ configured: undefined, fetchImpl, accountId: '', token: '' }),
    ).rejects.toThrow(/CLOUDFLARE/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the account id and token out of failure messages', async () => {
    const fetchImpl = stubFetch({
      [SCRIPTS_URL]: envelope([{ id: 'one' }, { id: 'two' }]),
      [PAGES_URL]: envelope([]),
    });
    const error = await resolveTargetService({
      configured: undefined,
      fetchImpl,
      accountId: 'test-account',
      token: 's3cr3t',
    }).catch((e: unknown) => e);
    const message: string = (error as Error).message;
    expect(message).toContain('PROXY_TARGET_SERVICE');
    expect(message).not.toContain('test-account');
    expect(message).not.toContain('s3cr3t');
  });
});
