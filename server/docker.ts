/**
 * Read-only Docker Engine API client for container status. It only ever sends GET requests to
 * /containers/json and /containers/{id}/json, so it works behind a socket proxy that allows
 * just CONTAINERS=1 (recommended: a raw docker.sock is root-equivalent on the host).
 */
import http from 'node:http';
import https from 'node:https';
import type { ContainerInfo, ContainerState } from '../shared/types.js';

export const DEFAULT_DOCKER_HOST = 'unix:///var/run/docker.sock';
const TIMEOUT_MS = 5000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_CHECK_OUTPUT = 500;

export type DockerTarget =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; protocol: 'http:' | 'https:'; host: string; port: number };

/** unix:///path, tcp://host:port (plain HTTP, like the docker CLI without TLS), http(s)://host:port. */
export function parseDockerHost(value: string): DockerTarget {
  if (value.startsWith('unix://')) return { kind: 'socket', socketPath: value.slice('unix://'.length) };
  if (value.startsWith('/')) return { kind: 'socket', socketPath: value };
  const url = new URL(value.replace(/^tcp:\/\//, 'http://'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported docker host "${value}"`);
  const protocol = url.protocol;
  return { kind: 'tcp', protocol, host: url.hostname, port: Number(url.port || (protocol === 'https:' ? 443 : 2375)) };
}

export type DockerGet = (path: string) => Promise<unknown>;

/** A GET-only JSON client for one Docker host. */
export function dockerClient(target: DockerTarget): DockerGet {
  return (path) =>
    new Promise((resolve, reject) => {
      const opts: http.RequestOptions = {
        method: 'GET',
        path,
        headers: { Accept: 'application/json', Host: 'docker' },
        timeout: TIMEOUT_MS,
        ...(target.kind === 'socket' ? { socketPath: target.socketPath } : { host: target.host, port: target.port }),
      };
      const mod = target.kind === 'tcp' && target.protocol === 'https:' ? https : http;
      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error('Docker response too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            let msg = body;
            try {
              msg = (JSON.parse(body) as { message?: string }).message ?? body;
            } catch {
              /* plain text */
            }
            reject(new Error(`Docker API ${res.statusCode}: ${msg.trim().slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Docker API returned invalid JSON'));
          }
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
      req.on('error', reject);
      req.end();
    });
}

interface ListedContainer {
  Id: string;
  Names?: string[];
  State?: string;
  Status?: string;
  Image?: string;
}

interface InspectedContainer {
  State?: {
    Status?: string;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: {
      Status?: string;
      FailingStreak?: number;
      Log?: { ExitCode?: number; Output?: string; End?: string }[];
    };
  };
  RestartCount?: number;
  Config?: { Image?: string };
}

const STATES: readonly ContainerState[] = ['running', 'restarting', 'paused', 'exited', 'created', 'dead', 'removing'];
const ZERO_TIME = '0001-01-01T00:00:00Z';

/** Turn Docker's list + inspect output into what the tile shows. Pure, for tests. */
export function toContainerInfo(name: string, listed: ListedContainer, inspected?: InspectedContainer): ContainerInfo {
  const raw = inspected?.State?.Status ?? listed.State ?? '';
  const state: ContainerState = (STATES as readonly string[]).includes(raw) ? (raw as ContainerState) : 'unknown';
  const info: ContainerInfo = { name, state };
  if (listed.Status) info.status = listed.Status;
  const image = inspected?.Config?.Image ?? listed.Image;
  if (image) info.image = image;
  const st = inspected?.State;
  if (st?.StartedAt && !st.StartedAt.startsWith('0001')) info.startedAt = st.StartedAt;
  if (st?.FinishedAt && st.FinishedAt !== ZERO_TIME && !st.FinishedAt.startsWith('0001')) info.finishedAt = st.FinishedAt;
  if (st?.ExitCode !== undefined && state !== 'running') info.exitCode = st.ExitCode;
  if (inspected?.RestartCount) info.restartCount = inspected.RestartCount;

  const health = st?.Health;
  if (health?.Status === 'healthy' || health?.Status === 'unhealthy' || health?.Status === 'starting') {
    info.health = health.Status;
    if (health.FailingStreak) info.failingStreak = health.FailingStreak;
    const last = health.Log?.at(-1);
    if (last) {
      info.lastCheck = {
        exitCode: last.ExitCode ?? -1,
        output: (last.Output ?? '').trim().slice(0, MAX_CHECK_OUTPUT),
        at: last.End ?? '',
      };
    }
  }
  return info;
}

/**
 * Look up containers by name. Returns name -> info; names with no container are 'missing'.
 * If Docker can't be reached, every name is 'unknown' with the error.
 */
export async function getContainers(names: string[], get: DockerGet): Promise<Map<string, ContainerInfo>> {
  const out = new Map<string, ContainerInfo>();
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return out;
  let list: ListedContainer[];
  try {
    list = (await get('/containers/json?all=1')) as ListedContainer[];
  } catch (err) {
    for (const n of wanted) out.set(n, { name: n, state: 'unknown', error: (err as Error).message });
    return out;
  }
  const byName = new Map<string, ListedContainer>();
  for (const c of list) for (const n of c.Names ?? []) byName.set(n.replace(/^\//, ''), c);

  await Promise.all(
    wanted.map(async (name) => {
      const listed = byName.get(name);
      if (!listed) {
        out.set(name, { name, state: 'missing' });
        return;
      }
      let inspected: InspectedContainer | undefined;
      try {
        inspected = (await get(`/containers/${encodeURIComponent(listed.Id)}/json`)) as InspectedContainer;
      } catch {
        /* the list entry alone is still useful */
      }
      out.set(name, toContainerInfo(name, listed, inspected));
    }),
  );
  return out;
}
