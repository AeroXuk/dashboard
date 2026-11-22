import { describe, expect, it } from 'vitest';
import { getContainers, parseDockerHost, toContainerInfo, type DockerGet } from '../server/docker.js';
import { containerHasIssue, containerTone } from '../web/render.js';

describe('parseDockerHost', () => {
  it('understands unix sockets, tcp and http(s)', () => {
    expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({ kind: 'socket', socketPath: '/var/run/docker.sock' });
    expect(parseDockerHost('/run/docker.sock')).toEqual({ kind: 'socket', socketPath: '/run/docker.sock' });
    expect(parseDockerHost('tcp://docker-proxy:2375')).toEqual({ kind: 'tcp', protocol: 'http:', host: 'docker-proxy', port: 2375 });
    expect(parseDockerHost('tcp://10.0.0.5')).toMatchObject({ host: '10.0.0.5', port: 2375 });
    expect(parseDockerHost('https://docker.lan:2376')).toEqual({ kind: 'tcp', protocol: 'https:', host: 'docker.lan', port: 2376 });
    expect(() => parseDockerHost('ftp://x')).toThrow();
  });
});

const list = [
  { Id: 'a1', Names: ['/jellyfin'], State: 'running', Status: 'Up 2 hours (healthy)', Image: 'jellyfin/jellyfin' },
  { Id: 'b2', Names: ['/immich_server'], State: 'exited', Status: 'Exited (137) 5 minutes ago', Image: 'immich' },
  { Id: 'c3', Names: ['/sonarr'], State: 'running', Status: 'Up 1 day', Image: 'sonarr' },
];
const inspect: Record<string, unknown> = {
  a1: {
    State: {
      Status: 'running',
      StartedAt: '2026-11-21T10:00:00Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      ExitCode: 0,
      Health: { Status: 'healthy', FailingStreak: 0, Log: [{ ExitCode: 0, Output: 'ok\n', End: '2026-11-21T12:00:00Z' }] },
    },
    RestartCount: 0,
    Config: { Image: 'jellyfin/jellyfin:10.10' },
  },
  b2: { State: { Status: 'exited', ExitCode: 137, FinishedAt: '2026-11-21T11:55:00Z', StartedAt: '2026-11-20T00:00:00Z' }, RestartCount: 3 },
};
const fakeGet: DockerGet = async (path) => {
  if (path === '/containers/json?all=1') return list;
  const id = path.match(/^\/containers\/([^/]+)\/json$/)?.[1];
  if (id && inspect[id]) return inspect[id];
  throw new Error('Docker API 404: no such container');
};

describe('getContainers', () => {
  it('looks containers up by name, inspects them, and marks missing ones', async () => {
    const out = await getContainers(['jellyfin', 'immich_server', 'sonarr', 'nope'], fakeGet);
    expect(out.get('jellyfin')).toEqual({
      name: 'jellyfin',
      state: 'running',
      health: 'healthy',
      status: 'Up 2 hours (healthy)',
      image: 'jellyfin/jellyfin:10.10',
      startedAt: '2026-11-21T10:00:00Z',
      lastCheck: { exitCode: 0, output: 'ok', at: '2026-11-21T12:00:00Z' },
    });
    expect(out.get('immich_server')).toMatchObject({ state: 'exited', exitCode: 137, restartCount: 3, finishedAt: '2026-11-21T11:55:00Z' });
    // inspect failed: still reported from the list
    expect(out.get('sonarr')).toEqual({ name: 'sonarr', state: 'running', status: 'Up 1 day', image: 'sonarr' });
    expect(out.get('nope')).toEqual({ name: 'nope', state: 'missing' });
  });

  it('reports every container as unknown when Docker is unreachable', async () => {
    const down: DockerGet = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const out = await getContainers(['a', 'b'], down);
    expect(out.get('a')).toEqual({ name: 'a', state: 'unknown', error: 'connect ECONNREFUSED' });
    expect(out.size).toBe(2);
  });
});

describe('container tone and issues', () => {
  const c = (state: string, health?: string) => toContainerInfo('x', { Id: '1', State: state }, health ? { State: { Status: state, Health: { Status: health } } } : undefined);
  it('maps states and healthchecks to colours', () => {
    expect(containerTone(c('running', 'healthy'))).toBe('healthy');
    expect(containerTone(c('running'))).toBe('running');
    expect(containerTone(c('running', 'starting'))).toBe('starting');
    expect(containerTone(c('running', 'unhealthy'))).toBe('unhealthy');
    expect(containerTone(c('restarting'))).toBe('starting');
    expect(containerTone(c('paused'))).toBe('paused');
    expect(containerTone(c('exited'))).toBe('stopped');
    expect(containerTone({ name: 'x', state: 'missing' })).toBe('idle');
    expect(containerTone(undefined)).toBe('pending');
  });
  it('flags problems but not an unreachable Docker', () => {
    expect(containerHasIssue(c('exited'))).toBe(true);
    expect(containerHasIssue(c('running', 'unhealthy'))).toBe(true);
    expect(containerHasIssue({ name: 'x', state: 'missing' })).toBe(true);
    expect(containerHasIssue(c('running', 'starting'))).toBe(false);
    expect(containerHasIssue({ name: 'x', state: 'unknown', error: 'e' })).toBe(false);
  });
});
