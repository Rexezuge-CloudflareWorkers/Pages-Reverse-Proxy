const DEFAULT_TARGET_BINDING: string = 'API_WORKER';

const CF_CONNECTING_IP_HEADER: string = 'CF-Connecting-IP';
const FORWARDED_FOR_HEADER: string = 'X-Forwarded-For';
const FORWARDED_HOST_HEADER: string = 'X-Forwarded-Host';
const FORWARDED_PROTO_HEADER: string = 'X-Forwarded-Proto';
const FORWARDED_URI_HEADER: string = 'X-Forwarded-Uri';

interface ProxyEnvironment {
  PROXY_TARGET_BINDING?: string;
  [binding: string]: Fetcher | string | undefined;
}

export const proxyToTarget: PagesFunction<ProxyEnvironment> = async ({ request, env }) => {
  const targetBinding: string = env.PROXY_TARGET_BINDING?.trim() || DEFAULT_TARGET_BINDING;

  const target: Fetcher | undefined = env[targetBinding] as Fetcher | undefined;
  if (!target || typeof target.fetch !== 'function') {
    return new Response(`Proxy target binding "${targetBinding}" is not configured.`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const originalUrl: URL = new URL(request.url);

  const headers: Headers = new Headers(request.headers);
  headers.set(FORWARDED_HOST_HEADER, originalUrl.host);
  headers.set(FORWARDED_PROTO_HEADER, originalUrl.protocol.replace(':', ''));
  headers.set(FORWARDED_URI_HEADER, `${originalUrl.pathname}${originalUrl.search}`);

  const clientIp: string | null = request.headers.get(CF_CONNECTING_IP_HEADER);
  if (clientIp) {
    headers.set(FORWARDED_FOR_HEADER, clientIp);
  }

  const hasBody: boolean = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;

  const proxyRequest: Request = new Request(originalUrl.href, {
    method: request.method,
    headers,
    body: hasBody ? (request.body as ReadableStream<Uint8Array> | null) : undefined,
    redirect: request.redirect,
    ...(hasBody ? { duplex: 'half' as const } : {}),
  });

  return target.fetch(proxyRequest);
};

export const onRequest: PagesFunction<ProxyEnvironment> = proxyToTarget;
