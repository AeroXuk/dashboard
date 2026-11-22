import { describe, expect, it } from 'vitest';
import { methodStatus, pickMethod } from '../web/select';

const order = ['local', 'tailnet', 'public'];

describe('pickMethod', () => {
  it('uses the first reachable method in order', () => {
    expect(pickMethod(order, { local: 'down', tailnet: 'up', public: 'up' })).toEqual({
      kind: 'method',
      method: 'tailnet',
    });
    expect(pickMethod(order, { local: 'up', tailnet: 'up', public: 'up' })).toEqual({ kind: 'method', method: 'local' });
  });

  it('waits while a higher-priority method is still pending', () => {
    expect(pickMethod(order, { local: 'pending', tailnet: 'up' })).toEqual({ kind: 'pending', tentative: 'local' });
    expect(pickMethod(order, { tailnet: 'up' })).toEqual({ kind: 'pending', tentative: 'local' });
  });

  it('settles once every higher-priority method has failed, ignoring slower lower ones', () => {
    expect(pickMethod(order, { local: 'down', tailnet: 'up', public: 'pending' })).toEqual({
      kind: 'method',
      method: 'tailnet',
    });
  });

  it('honours a pinned method only when it is reachable', () => {
    const res = { local: 'up', tailnet: 'up', public: 'up' } as const;
    expect(pickMethod(order, res, 'public')).toEqual({ kind: 'method', method: 'public' });
    expect(pickMethod(order, { ...res, public: 'down' }, 'public')).toEqual({ kind: 'method', method: 'local' });
    expect(pickMethod(order, { ...res, public: 'pending' }, 'public')).toEqual({ kind: 'method', method: 'local' });
    expect(pickMethod(['local'], { local: 'up' }, 'public')).toEqual({ kind: 'method', method: 'local' });
  });

  it('returns none with the first method as fallback when everything is down', () => {
    expect(pickMethod(order, { local: 'down', tailnet: 'down', public: 'down' })).toEqual({
      kind: 'none',
      fallback: 'local',
    });
    expect(pickMethod([], {})).toEqual({ kind: 'none', fallback: undefined });
  });
});

describe('methodStatus', () => {
  it('is online when any URL is up', () => {
    expect(methodStatus(['down', 'up', 'pending'])).toEqual({ status: 'online', up: 1, total: 3 });
  });
  it('is checking when nothing is up yet but probes are pending', () => {
    expect(methodStatus(['down', 'pending'])).toEqual({ status: 'checking', up: 0, total: 2 });
  });
  it('is offline when every URL failed', () => {
    expect(methodStatus(['down', 'down'])).toEqual({ status: 'offline', up: 0, total: 2 });
  });
  it('is unused when no service has a URL for it', () => {
    expect(methodStatus([])).toEqual({ status: 'unused', up: 0, total: 0 });
  });
});
