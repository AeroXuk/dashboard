import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheKey, classifyIcon, ICON_CDN, resolveAllIcons, resolveIcon } from '../server/icons.js';

describe('classifyIcon', () => {
  it('classifies URLs as remote', () => {
    expect(classifyIcon('https://example.com/a.png')).toEqual({ kind: 'remote', urls: ['https://example.com/a.png'] });
    expect(classifyIcon('http://example.com/icon')).toEqual({ kind: 'remote', urls: ['http://example.com/icon'] });
  });

  it('classifies image filenames as local', () => {
    expect(classifyIcon('nas.png')).toEqual({ kind: 'local', file: 'nas.png' });
    expect(classifyIcon('sub/dir/Logo.SVG')).toEqual({ kind: 'local', file: 'sub/dir/Logo.SVG' });
    expect(classifyIcon('photo.jpeg')).toEqual({ kind: 'local', file: 'photo.jpeg' });
  });

  it('rejects unsafe local paths', () => {
    expect(classifyIcon('../secret.png')).toBeNull();
    expect(classifyIcon('a/../../b.png')).toBeNull();
    expect(classifyIcon('/etc/x.png')).toBeNull();
    expect(classifyIcon('a\\b.png')).toBeNull();
    expect(classifyIcon('C:/x.png')).toBeNull();
  });

  it('maps bare names to the dashboard-icons CDN, svg then png', () => {
    expect(classifyIcon('Home-Assistant')).toEqual({
      kind: 'remote',
      urls: [`${ICON_CDN}/svg/home-assistant.svg`, `${ICON_CDN}/png/home-assistant.png`],
    });
  });

  it('returns null for unusable specs', () => {
    expect(classifyIcon('')).toBeNull();
    expect(classifyIcon('not a name')).toBeNull();
    expect(classifyIcon('ftp://x/y.png')).toBeNull();
  });
});

describe('resolveIcon', () => {
  let dir: string;
  let iconsDir: string;
  let cacheDir: string;
  const log = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dash-icons-'));
    iconsDir = path.join(dir, 'icons');
    cacheDir = path.join(dir, 'cache');
    await mkdir(iconsDir);
    log.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const image = (type: string, body = '<svg/>') =>
    new Response(body, { status: 200, headers: { 'content-type': type } });

  it('serves existing local files and skips missing ones', async () => {
    await writeFile(path.join(iconsDir, 'nas.png'), 'x');
    expect(await resolveIcon('nas.png', { iconsDir, cacheDir, log })).toBe('/icons/local/nas.png');
    expect(await resolveIcon('missing.png', { iconsDir, cacheDir, log })).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('downloads once, then serves from cache without fetching again', async () => {
    const fetchImpl = vi.fn(async () => image('image/svg+xml'));
    const opts = { iconsDir, cacheDir, log, fetchImpl: fetchImpl as unknown as typeof fetch };
    const key = cacheKey('jellyfin');

    expect(await resolveIcon('jellyfin', opts)).toBe(`/icons/cache/${key}.svg`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(cacheDir)).toEqual([`${key}.svg`]);

    expect(await resolveIcon('jellyfin', opts)).toBe(`/icons/cache/${key}.svg`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next candidate URL (svg 404 -> png)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('.svg') ? new Response('nope', { status: 404 }) : image('image/png', 'png'),
    );
    const out = await resolveIcon('sonarr', { iconsDir, cacheDir, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toBe(`/icons/cache/${cacheKey('sonarr')}.png`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the URL extension when the content-type is generic', async () => {
    const fetchImpl = vi.fn(async () => image('application/octet-stream', 'x'));
    const spec = 'https://example.com/logo.webp';
    const out = await resolveIcon(spec, { iconsDir, cacheDir, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toBe(`/icons/cache/${cacheKey(spec)}.webp`);
  });

  it('returns undefined on failure: network error, non-image, too large', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(
      await resolveIcon('https://x.example/a.png', { iconsDir, cacheDir, log, fetchImpl: throwing as unknown as typeof fetch }),
    ).toBeUndefined();

    const html = vi.fn(async () => image('text/html', '<html>'));
    expect(
      await resolveIcon('https://x.example/b.png', { iconsDir, cacheDir, log, fetchImpl: html as unknown as typeof fetch }),
    ).toBeUndefined();

    const big = vi.fn(async () => image('image/png', 'x'.repeat(2 * 1024 * 1024 + 1)));
    expect(
      await resolveIcon('https://x.example/c.png', { iconsDir, cacheDir, log, fetchImpl: big as unknown as typeof fetch }),
    ).toBeUndefined();
  });
});

describe('resolveAllIcons', () => {
  it('resolves each distinct spec once', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dash-icons-'));
    try {
      const fetchImpl = vi.fn(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
      const map = await resolveAllIcons([{ iconSpec: 'a' }, { iconSpec: 'a' }, { iconSpec: 'b' }, {}], {
        iconsDir: path.join(dir, 'icons'),
        cacheDir: path.join(dir, 'cache'),
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect([...map.keys()]).toEqual(['a', 'b']);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
