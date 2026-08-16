import { describe, expect, it, vi } from 'vitest';
import { proxyToTarget } from '../functions/[[path]]';

function buildEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PROXY_TARGET_BINDING: undefined,
    API_WORKER: { fetch: vi.fn() },
    ...overrides,
  };
}

function buildContext(env: Record<string, unknown>, request: Request) {
  return {
    request,
    env,
    params: {},
    data: {},
    next: vi.fn(),
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
}

describe('proxyToTarget', () => {
  it('proxies to the default API_WORKER binding when no target binding is configured', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('upstream', { status: 200 }));
    const env = buildEnv({ API_WORKER: { fetch: targetFetch }, PROXY_TARGET_BINDING: undefined });
    const request = new Request('https://example.com/user/me?a=1', { method: 'GET' });

    const response = await proxyToTarget(buildContext(env, request) as never);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream');
    expect(targetFetch).toHaveBeenCalledOnce();
    expect(targetFetch.mock.calls[0][0].url).toBe('https://example.com/user/me?a=1');
  });

  it('uses the configured PROXY_TARGET_BINDING env var to select the target worker', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const env = buildEnv({
      API_WORKER: { fetch: vi.fn() },
      OTHER_WORKER: { fetch: targetFetch },
      PROXY_TARGET_BINDING: 'OTHER_WORKER',
    });
    const request = new Request('https://example.com/anything', { method: 'GET' });

    const response = await proxyToTarget(buildContext(env, request) as never);

    expect(response.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledOnce();
  });

  it('returns 502 when the selected binding is not configured', async () => {
    const env = buildEnv({ API_WORKER: undefined, PROXY_TARGET_BINDING: undefined });
    const request = new Request('https://example.com/', { method: 'GET' });

    const response = await proxyToTarget(buildContext(env, request) as never);

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('API_WORKER');
    expect(env.API_WORKER).toBeUndefined();
  });

  it('returns 502 when the selected binding is not a service binding', async () => {
    const env = buildEnv({ API_WORKER: 'not-a-fetcher', PROXY_TARGET_BINDING: undefined });
    const request = new Request('https://example.com/', { method: 'GET' });

    const response = await proxyToTarget(buildContext(env, request) as never);

    expect(response.status).toBe(502);
  });

  it('forwards host, protocol, and uri of the original request', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const env = buildEnv({ API_WORKER: { fetch: targetFetch } });
    const request = new Request('https://app.example.test:8443/some/path?q=value#frag', { method: 'GET' });

    await proxyToTarget(buildContext(env, request) as never);

    const forwarded: Headers = targetFetch.mock.calls[0][0].headers;
    expect(forwarded.get('X-Forwarded-Host')).toBe('app.example.test:8443');
    expect(forwarded.get('X-Forwarded-Proto')).toBe('https');
    expect(forwarded.get('X-Forwarded-Uri')).toBe('/some/path?q=value');
  });

  it('maps CF-Connecting-IP to X-Forwarded-For', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const env = buildEnv({ API_WORKER: { fetch: targetFetch } });
    const request = new Request('https://example.com/', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    });

    await proxyToTarget(buildContext(env, request) as never);

    expect(targetFetch.mock.calls[0][0].headers.get('X-Forwarded-For')).toBe('203.0.113.7');
  });

  it('does not set X-Forwarded-For when CF-Connecting-IP is absent', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const env = buildEnv({ API_WORKER: { fetch: targetFetch } });
    const request = new Request('https://example.com/', { method: 'GET' });

    await proxyToTarget(buildContext(env, request) as never);

    expect(targetFetch.mock.calls[0][0].headers.get('X-Forwarded-For')).toBeNull();
  });

  it('forwards the request body for non-GET methods', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const env = buildEnv({ API_WORKER: { fetch: targetFetch } });
    const request = new Request('https://example.com/api/hook', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'Content-Type': 'application/json' },
    });

    await proxyToTarget(buildContext(env, request) as never);

    const proxied = targetFetch.mock.calls[0][0];
    expect(proxied.method).toBe('POST');
    expect(await proxied.text()).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('does not attach a body to GET and HEAD requests', async () => {
    const targetFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const env = buildEnv({ API_WORKER: { fetch: targetFetch } });

    await proxyToTarget(buildContext(env, new Request('https://example.com/', { method: 'GET' })) as never);
    await proxyToTarget(buildContext(env, new Request('https://example.com/', { method: 'HEAD' })) as never);

    expect(targetFetch).toHaveBeenCalledTimes(2);
    for (const call of targetFetch.mock.calls) {
      expect(call[0].body).toBeNull();
    }
  });
});
