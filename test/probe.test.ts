import { describe, expect, it } from 'vitest';
import { localNetworkInit } from '../web/probe';

describe('localNetworkInit', () => {
  it('marks http:// URLs as local when the page is served over https', () => {
    expect(localNetworkInit('http://10.0.0.10:8096/', 'https:')).toEqual({ targetAddressSpace: 'local' });
    expect(localNetworkInit('http://nas.local/', 'https:')).toEqual({ targetAddressSpace: 'local' });
    expect(localNetworkInit('http://sonarr.example.com/ping', 'https:')).toEqual({ targetAddressSpace: 'local' });
  });

  it('adds nothing when the page itself is http', () => {
    expect(localNetworkInit('http://10.0.0.10:8096/', 'http:')).toEqual({});
  });

  it('adds nothing for https:// URLs', () => {
    expect(localNetworkInit('https://10.0.0.10/', 'https:')).toEqual({});
  });

  it('leaves loopback hosts alone', () => {
    for (const url of ['http://localhost:3000/', 'http://app.localhost/', 'http://127.0.0.1:8080/', 'http://[::1]/']) {
      expect(localNetworkInit(url, 'https:')).toEqual({});
    }
  });

  it('ignores URLs it cannot parse', () => {
    expect(localNetworkInit('not a url', 'https:')).toEqual({});
  });
});
