/**
 * Server-side HTTP checks. The browser's no-cors probes can tell whether a URL answers, but
 * not with what status, so a proxy's 404/502 for a stopped container looks "up". The server
 * requests each probe URL itself and reports HTTP error statuses, which the browser overlays
 * on its own results.
 *
 * The server only sees its own network: a URL it can't reach (other network, self-signed
 * certificate, DNS it can't resolve) gives no result, and the browser's view stands.
 */
import type { ClientConfig, ContainerInfo, HealthResponse } from '../shared/types.js';
import { DEFAULT_DOCKER_HOST, dockerClient, getContainers, parseDockerHost, type DockerGet } from './docker.js';

export const CHECK_TIMEOUT_MS = 6000;
export const CHECK_CONCURRENCY = 12;

export type UrlCheck = { status: number } | { error: string };

/** GET a URL (following redirects) and return its final status. The body is not read. */
export async function checkUrl(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = CHECK_TIMEOUT_MS): Promise<UrlCheck> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'dashboard-health-check', Accept: 'text/html,*/*' },
    });
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Whether a status means the service is broken. Login prompts (by default 401/403) count as working. */
export function isHttpError(status: number, okStatuses: readonly number[]): boolean {
  return status >= 400 && !okStatuses.includes(status);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Check every probe URL in the config once. Returns serviceId -> method -> HTTP error status. */
export async function runChecks(
  config: ClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthResponse['errors']> {
  const urls = [...new Set(config.services.flatMap((s) => Object.values(s.probeUrls)))];
  const checks = await mapLimit(urls, CHECK_CONCURRENCY, (u) => checkUrl(u, fetchImpl));
  const byUrl = new Map(urls.map((u, i) => [u, checks[i]!] as const));

  const errors: HealthResponse['errors'] = {};
  for (const svc of config.services) {
    for (const [method, url] of Object.entries(svc.probeUrls)) {
      const c = byUrl.get(url);
      if (c && 'status' in c && isHttpError(c.status, config.settings.httpOkStatuses)) {
        (errors[svc.id] ??= {})[method] = c.status;
      }
    }
  }
  return errors;
}

/** Container state per service (for services with `container:`). */
export async function runContainerChecks(config: ClientConfig, get: DockerGet): Promise<Record<string, ContainerInfo>> {
  const withContainer = config.services.filter((s) => s.container);
  if (withContainer.length === 0) return {};
  const infos = await getContainers(
    withContainer.map((s) => s.container!),
    get,
  );
  return Object.fromEntries(withContainer.map((s) => [s.id, infos.get(s.container!)!] as const));
}

export interface CheckTarget {
  config: ClientConfig;
  /** docker.host from the config, if set. */
  dockerHost?: string;
}

export interface CheckerDeps {
  fetchImpl?: typeof fetch;
  /** Builds a Docker client for a host string (tests swap this out). */
  docker?: (host: string) => DockerGet;
}

/** Runs checks on a timer and on demand, keeping the latest results for /api/health. */
export class HealthChecker {
  private result: HealthResponse = { enabled: false, checkedAt: null, errors: {}, containers: {} };
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly docker: (host: string) => DockerGet;

  constructor(
    private readonly getTarget: () => CheckTarget | null,
    deps: CheckerDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.docker = deps.docker ?? ((host) => dockerClient(parseDockerHost(host)));
  }

  get latest(): HealthResponse {
    return this.result;
  }

  private enabledFor(t: CheckTarget | null): boolean {
    return !!t && (t.config.settings.httpCheck || t.config.services.some((s) => s.container));
  }

  /** Call after every config load: resets results and restarts the timer. */
  reset(): void {
    this.generation++;
    clearInterval(this.timer);
    const target = this.getTarget();
    const enabled = this.enabledFor(target);
    this.result = { enabled, checkedAt: null, errors: {}, containers: {} };
    if (!enabled || !target) return;
    // With no re-check interval set, still refresh in the background every minute.
    const sec = Math.max(target.config.settings.reprobeIntervalSec || 60, 15);
    this.timer = setInterval(() => void this.run(), sec * 1000);
    this.timer.unref?.();
    void this.run();
  }

  /** Run a check now, or join one already running. */
  run(): Promise<void> {
    if (this.running) return this.running;
    const target = this.getTarget();
    if (!target || !this.enabledFor(target)) return Promise.resolve();
    const { config } = target;
    const gen = this.generation;
    const host = target.dockerHost ?? process.env.DOCKER_HOST ?? DEFAULT_DOCKER_HOST;
    const containers = (async () => {
      if (!config.services.some((s) => s.container)) return {};
      let get: DockerGet;
      try {
        get = this.docker(host);
      } catch (err) {
        const error = (err as Error).message;
        return Object.fromEntries(
          config.services
            .filter((s) => s.container)
            .map((s) => [s.id, { name: s.container!, state: 'unknown', error } satisfies ContainerInfo] as const),
        );
      }
      return runContainerChecks(config, get);
    })();
    const errors = config.settings.httpCheck ? runChecks(config, this.fetchImpl) : Promise.resolve({});
    this.running = Promise.all([errors, containers])
      .then(([errs, ctrs]) => {
        if (gen === this.generation) this.result = { enabled: true, checkedAt: Date.now(), errors: errs, containers: ctrs };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Fresh results if the last check is older than maxAgeMs (waiting at most waitMs). */
  async fresh(maxAgeMs: number, waitMs: number): Promise<HealthResponse> {
    const age = this.result.checkedAt === null ? Infinity : Date.now() - this.result.checkedAt;
    if (this.result.enabled && age > maxAgeMs) {
      await Promise.race([this.run(), new Promise((r) => setTimeout(r, waitMs))]);
    }
    return this.result;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
