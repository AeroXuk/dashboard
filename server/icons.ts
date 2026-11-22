import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';
export const DOWNLOAD_TIMEOUT_MS = 8000;
export const MAX_ICON_BYTES = 2 * 1024 * 1024;

const IMAGE_EXTS = ['svg', 'png', 'webp', 'jpg', 'jpeg', 'gif', 'ico'] as const;
const IMAGE_EXT_RE = /\.(png|svg|webp|jpe?g|gif|ico)$/i;

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

export type IconSource = { kind: 'local'; file: string } | { kind: 'remote'; urls: string[] };

export interface IconOptions {
  iconsDir: string;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/** Decide where an icon spec from the config comes from. Returns null for specs we can't use. */
export function classifyIcon(spec: string): IconSource | null {
  const s = spec.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    return URL.canParse(s) ? { kind: 'remote', urls: [s] } : null;
  }
  if (IMAGE_EXT_RE.test(s)) {
    if (s.includes('\\') || s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
    if (s.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
    return { kind: 'local', file: s };
  }
  if (/^[a-z0-9-]+$/i.test(s)) {
    const name = s.toLowerCase();
    return { kind: 'remote', urls: [`${ICON_CDN}/svg/${name}.svg`, `${ICON_CDN}/png/${name}.png`] };
  }
  return null;
}

export function cacheKey(spec: string): string {
  return createHash('sha1').update(spec.trim()).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function extFromUrl(url: string): string | undefined {
  try {
    const m = new URL(url).pathname.match(IMAGE_EXT_RE);
    if (!m) return undefined;
    const e = m[1]!.toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
  } catch {
    return undefined;
  }
}

async function download(url: string, fetchImpl: typeof fetch): Promise<{ data: Uint8Array; ext: string }> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ICON_BYTES) throw new Error(`too large (${declared} bytes)`);

  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  let ext = CONTENT_TYPE_EXT[type];
  if (!ext) {
    // Some servers send octet-stream or nothing; trust the URL extension only then.
    const generic = type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream';
    const urlExt = extFromUrl(url);
    if (!generic || !urlExt) throw new Error(`not an image (content-type "${type || 'none'}")`);
    ext = urlExt;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_ICON_BYTES) throw new Error(`too large (${buf.byteLength} bytes)`);
  if (buf.byteLength === 0) throw new Error('empty response');
  return { data: buf, ext };
}

/**
 * Resolve an icon spec to a path the dashboard serves itself:
 * - '/icons/local/<file>' for files in the mounted icons folder (only if it exists)
 * - '/icons/cache/<sha1>.<ext>' for CDN names and URLs (downloaded once, then reused)
 * - undefined when the icon can't be used (the browser falls back to a letter avatar)
 */
export async function resolveIcon(spec: string, opts: IconOptions): Promise<string | undefined> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const src = classifyIcon(spec);
  if (!src) {
    log(`[icons] ignoring unusable icon "${spec}"`);
    return undefined;
  }

  if (src.kind === 'local') {
    const full = path.resolve(opts.iconsDir, src.file);
    const root = path.resolve(opts.iconsDir) + path.sep;
    if (!full.startsWith(root)) return undefined;
    try {
      if ((await stat(full)).isFile()) {
        return '/icons/local/' + src.file.split('/').map(encodeURIComponent).join('/');
      }
    } catch {
      /* fall through */
    }
    log(`[icons] local icon not found: ${full}`);
    return undefined;
  }

  const key = cacheKey(spec);
  for (const ext of IMAGE_EXTS) {
    if (await exists(path.join(opts.cacheDir, `${key}.${ext}`))) return `/icons/cache/${key}.${ext}`;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  for (const url of src.urls) {
    try {
      const { data, ext } = await download(url, fetchImpl);
      await mkdir(opts.cacheDir, { recursive: true });
      const final = path.join(opts.cacheDir, `${key}.${ext}`);
      const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, data);
      try {
        await rename(tmp, final);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      return `/icons/cache/${key}.${ext}`;
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  log(`[icons] could not fetch icon "${spec}": ${errors.join('; ')}`);
  return undefined;
}

/** Resolve every distinct icon spec concurrently. Returns spec -> served path (or undefined). */
export async function resolveAllIcons(
  services: { iconSpec?: string }[],
  opts: IconOptions,
): Promise<Map<string, string | undefined>> {
  const specs = [...new Set(services.map((s) => s.iconSpec).filter((s): s is string => !!s))];
  const results = await Promise.all(specs.map((s) => resolveIcon(s, opts)));
  return new Map(specs.map((s, i) => [s, results[i]]));
}
