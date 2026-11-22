import { describe, expect, it, vi } from 'vitest';
import { parseConfig, toClientConfig } from '../server/config.js';
import { checkUrl, isHttpError, runChecks } from '../server/health.js';

function config(extra = '') {
  const r = parseConfig(`
settings:
  httpCheck: true
${extra}
methods:
  local:
  public:
services:
  - name: Immich
    urls:
      local: http://10.0.0.1:2283
      public: https://immich.example.com
  - name: Sonarr
    probe: /ping
    urls:
      local: http://10.0.0.1:8989
      public: https://sonarr.example.com
  - name: Locked
    urls:
      public: https://locked.example.com
`);
  if (!r.ok) throw new Error(r.error);
  return toClientConfig(r.config);
}

const respond = (map: Record<string, number | Error>) =>
  vi.fn(async (url: string | URL | Request) => {
    const v = map[String(url)];
    if (v === undefined || v instanceof Error) throw v ?? new Error('ECONNREFUSED');
    return new Response(null, { status: v });
  }) as unknown as typeof fetch;

describe('isHttpError', () => {
  it('treats 4xx/5xx as errors except the allowed statuses', () => {
    expect(isHttpError(200, [401, 403])).toBe(false);
    expect(isHttpError(302, [401, 403])).toBe(false);
    expect(isHttpError(404, [401, 403])).toBe(true);
    expect(isHttpError(502, [401, 403])).toBe(true);
    expect(isHttpError(401, [401, 403])).toBe(false);
    expect(isHttpError(403, [])).toBe(true);
  });
});

describe('checkUrl', () => {
  it('returns the status, or the error when the request fails', async () => {
    const f = respond({ 'http://a/': 404 });
    expect(await checkUrl('http://a/', f)).toEqual({ status: 404 });
    expect(await checkUrl('http://b/', f)).toEqual({ error: 'ECONNREFUSED' });
  });
});

describe('runChecks', () => {
  it('reports only HTTP error statuses, per service and method, using probe URLs', async () => {
    const f = respond({
      'https://immich.example.com': 404, // proxy up, container down
      'https://sonarr.example.com/ping': 200,
      'http://10.0.0.1:8989/ping': 502,
      'https://locked.example.com': 401, // login prompt: fine
      // http://10.0.0.1:2283/ unreachable from the server: no result
    });
    expect(await runChecks(config(), f)).toEqual({
      immich: { public: 404 },
      sonarr: { local: 502 },
    });
  });

  it('respects httpOkStatuses', async () => {
    const f = respond({ 'https://locked.example.com': 401, 'https://immich.example.com': 404 });
    const errors = await runChecks(config('  httpOkStatuses: [404]'), f);
    expect(errors).toEqual({ locked: { public: 401 } });
  });

  it('requests each distinct URL once', async () => {
    const f = respond({});
    await runChecks(config(), f);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
  });
});
