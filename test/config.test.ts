import { describe, expect, it } from 'vitest';
import { parseConfig, slugify, toClientConfig } from '../server/config.js';
import { readFileSync } from 'node:fs';

const base = `
methods:
  local: { label: LAN }
  tailnet:
  public: {}
services:
  - name: Jellyfin
    icon: jellyfin
    urls:
      local: http://192.168.1.10:8096
      public: https://jf.example.com
`;

function ok(text: string) {
  const r = parseConfig(text);
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

function err(text: string) {
  const r = parseConfig(text);
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

describe('parseConfig', () => {
  it('parses a valid config and applies defaults', () => {
    const c = ok(base);
    expect(c.title).toBe('Dashboard');
    expect(c.settings).toEqual({
      probeTimeoutMs: 2500,
      reprobeIntervalSec: 60,
      openInNewTab: true,
      httpCheck: true,
      httpOkStatuses: [401, 403],
    });
    expect(c.methods).toEqual([
      { id: 'local', label: 'LAN', glyph: 'home' },
      { id: 'tailnet', label: 'tailnet', glyph: 'vpn' },
      { id: 'public', label: 'public', glyph: 'globe' },
    ]);
    const s = c.services[0]!;
    expect(s.id).toBe('jellyfin');
    expect(s.order).toEqual(['local', 'public']);
    expect(s.probeUrls).toEqual(s.urls);
    expect(s.iconSpec).toBe('jellyfin');
  });

  it('parses the bundled example config', () => {
    const text = readFileSync(new URL('../config/config.example.yaml', import.meta.url), 'utf8');
    const c = ok(text);
    expect(c.services.length).toBeGreaterThan(0);
  });

  it('orders methods as written, including numeric-looking names', () => {
    const c = ok(`
methods:
  c:
  '2':
  a:
services:
  - name: X
    urls: { a: http://a, '2': http://b, c: http://c }
`);
    expect(c.methods.map((m) => m.id)).toEqual(['c', '2', 'a']);
    expect(c.services[0]!.order).toEqual(['c', '2', 'a']);
  });

  it('explains that the old top-level order is gone', () => {
    expect(err('methods: { a: null }\norder: [a]\nservices: []\n')).toMatch(/order: no longer used/);
  });

  it('uses per-service order as given, filtered to methods with URLs', () => {
    const c = ok(`
methods: { local: null, tailnet: null, public: null }
services:
  - name: X
    order: [public, tailnet, local]
    urls: { local: http://l, public: https://p }
`);
    expect(c.services[0]!.order).toEqual(['public', 'local']);
  });

  it('resolves probe paths against each URL', () => {
    const c = ok(`
methods: { a: null, b: null }
services:
  - name: X
    probe: /health
    urls: { a: http://h:8080/app/, b: https://x.example.com/app/ }
  - name: Y
    probe: ping
    urls: { a: http://h:8080/app/ }
`);
    expect(c.services[0]!.probeUrls).toEqual({ a: 'http://h:8080/health', b: 'https://x.example.com/health' });
    expect(c.services[1]!.probeUrls).toEqual({ a: 'http://h:8080/app/ping' });
  });

  it('makes service ids unique', () => {
    const c = ok(`
methods: { a: null }
services:
  - { name: Home Assistant, urls: { a: http://x } }
  - { name: home assistant, urls: { a: http://y } }
`);
    expect(c.services.map((s) => s.id)).toEqual(['home-assistant', 'home-assistant-2']);
  });

  it('reports unknown methods in urls with a readable path', () => {
    const e = err(`
methods: { local: null }
services:
  - { name: A, urls: { local: http://a } }
  - { name: B, urls: { local: http://b } }
  - { name: C, urls: { foo: http://c } }
`);
    expect(e).toContain('services[2].urls.foo: unknown method "foo"');
  });

  it('reports unknown methods in per-service order', () => {
    expect(err(`
methods: { local: null }
services:
  - { name: A, order: [zzz], urls: { local: http://a } }
`)).toContain('services[0].order[0]: unknown method "zzz"');
  });

  it('rejects services without URLs, bad URLs, bad method names and unknown keys', () => {
    expect(err(`methods: { a: null }\nservices:\n  - { name: A, urls: {} }`)).toContain('services[0].urls');
    expect(err(`methods: { a: null }\nservices:\n  - { name: A, urls: { a: ftp://x } }`)).toContain('http');
    expect(err(`methods: { "bad name": null }\nservices: []`)).toContain('methods.bad name');
    expect(err(`methods: { a: null }\nservices:\n  - { name: A, url: { a: http://x }, urls: { a: http://x } }`)).toContain('services[0]');
  });

  it('accepts and ignores the reserved status key', () => {
    const c = ok(`
methods: { a: null }
services:
  - { name: A, status: { script: check.sh }, urls: { a: http://x } }
`);
    expect(c.services[0]).not.toHaveProperty('status');
  });

  it('reports YAML syntax errors and non-mapping documents', () => {
    expect(err('methods: [')).toMatch(/YAML/);
    expect(err('')).toMatch(/mapping/);
  });
});

describe('toClientConfig', () => {
  it('strips iconSpec and attaches resolved icon paths', () => {
    const c = ok(base);
    const client = toClientConfig(c, new Map([['jellyfin', '/icons/cache/abc.svg']]));
    expect(client.services[0]).not.toHaveProperty('iconSpec');
    expect(client.services[0]!.icon).toBe('/icons/cache/abc.svg');
    const noIcon = toClientConfig(c);
    expect(noIcon.services[0]).not.toHaveProperty('icon');
  });
});

describe('groups', () => {
  const svc = (name: string, group?: string) =>
    `  - name: ${name}\n${group ? `    group: ${group}\n` : ''}    urls: { local: http://a }\n`;
  const doc = (groups: string) => `methods:\n  local:\n${groups}services:\n${svc('A', 'Media')}${svc('B', 'Home')}${svc('C')}${svc('D', 'Infra')}`;

  it('orders by first appearance by default', () => {
    expect(ok(doc('')).groups).toEqual([
      { name: 'Media', label: 'Media', collapsed: false },
      { name: 'Home', label: 'Home', collapsed: false },
      { name: 'Infra', label: 'Infra', collapsed: false },
    ]);
  });

  it('puts listed groups first, supports collapsed, and skips empty ones', () => {
    const c = ok(doc('groups:\n  Infra:\n    collapsed: true\n  Unused:\n  Home:\n'));
    expect(c.groups).toEqual([
      { name: 'Infra', label: 'Infra', collapsed: true },
      { name: 'Home', label: 'Home', collapsed: false },
      { name: 'Media', label: 'Media', collapsed: false },
    ]);
  });

  it('takes built-in or image icons for groups', () => {
    const c = ok(doc('groups:\n  Media: { icon: film }\n  Home: { icon: home-assistant }\n'));
    expect(c.groups[0]).toEqual({ name: 'Media', label: 'Media', collapsed: false, glyph: 'film' });
    expect(c.groups[1]).toEqual({ name: 'Home', label: 'Home', collapsed: false, iconSpec: 'home-assistant' });
    const client = toClientConfig(c, new Map([['home-assistant', '/icons/cache/ha.svg']]));
    expect(client.groups[1]).toEqual({ name: 'Home', label: 'Home', collapsed: false, icon: '/icons/cache/ha.svg' });
    expect(toClientConfig(c).groups[1]).toEqual({ name: 'Home', label: 'Home', collapsed: false });
  });

  it('uses label as the display name, defaulting to the name', () => {
    const c = ok(doc('groups:\n  Infra: { label: Infrastructure & Network }\n  Home:\n'));
    expect(c.groups.map((g) => [g.name, g.label])).toEqual([
      ['Infra', 'Infrastructure & Network'],
      ['Home', 'Home'],
      ['Media', 'Media'],
    ]);
  });

  it('explains that groups is now a mapping', () => {
    expect(err(doc('groups: [Home, Media]\n'))).toMatch(/groups: is now a mapping/);
  });

  it('rejects duplicate group keys as a YAML error', () => {
    expect(err(doc('groups:\n  Home:\n  Home:\n'))).toMatch(/YAML/);
  });
});

describe('method icons', () => {
  it('guesses a built-in glyph when no icon is set', () => {
    const c = ok(`
methods:
  local: { label: LAN }
  tailnet:
  cf: { label: Cloudflare tunnel }
  other:
services:
  - name: A
    urls: { local: http://a }
`);
    expect(c.methods.map((m) => m.glyph)).toEqual(['home', 'vpn', 'globe', 'link']);
  });

  it('uses built-in names directly and resolves anything else like a service icon', () => {
    const c = ok(`
methods:
  local: { icon: wifi }
  tailnet: { icon: tailscale }
services:
  - name: A
    urls: { local: http://a }
`);
    expect(c.methods[0]).toMatchObject({ glyph: 'wifi' });
    expect(c.methods[1]).toMatchObject({ iconSpec: 'tailscale' });
    expect(c.methods[1]).not.toHaveProperty('glyph');

    const resolved = toClientConfig(c, new Map([['tailscale', '/icons/cache/ts.svg']]));
    expect(resolved.methods[1]).toEqual({ id: 'tailnet', label: 'tailnet', icon: '/icons/cache/ts.svg' });

    const failed = toClientConfig(c);
    expect(failed.methods[1]).toEqual({ id: 'tailnet', label: 'tailnet', glyph: 'vpn' });
  });
});

describe('slugify', () => {
  it('slugs names', () => {
    expect(slugify('Home Assistant!')).toBe('home-assistant');
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('***')).toBe('service');
  });
});
