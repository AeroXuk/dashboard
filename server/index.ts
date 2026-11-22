import { existsSync, watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ConfigResponse } from '../shared/types.js';
import { parseConfig, toClientConfig } from './config.js';
import { resolveAllIcons } from './icons.js';
import { HealthChecker } from './health.js';

// --- paths -----------------------------------------------------------------
// Running from source (tsx): <root>/server/index.ts. Built: <root>/dist/server/index.js.
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.basename(path.dirname(here)) === 'dist' ? path.resolve(here, '../..') : path.resolve(here, '..');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH ?? './config/config.yaml');
const ICONS_DIR = path.resolve(process.env.ICONS_DIR ?? './icons');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
const CACHE_DIR = path.join(DATA_DIR, 'icon-cache');
const WEB_DIR = path.resolve(process.env.WEB_DIR ?? path.join(appRoot, 'dist/web'));
const EXAMPLE_CONFIG = path.join(appRoot, 'config/config.example.yaml');

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const log = (msg: string) => app.log.warn(msg);

// --- config state ----------------------------------------------------------
const state: ConfigResponse = { version: 0, config: null, error: null };
let loadSeq = 0;
let dockerHost: string | undefined;
const health = new HealthChecker(() => (state.config ? { config: state.config, dockerHost } : null));

async function ensureConfigFile(): Promise<void> {
  if (existsSync(CONFIG_PATH)) return;
  try {
    await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    if (existsSync(EXAMPLE_CONFIG)) {
      await copyFile(EXAMPLE_CONFIG, CONFIG_PATH);
      app.log.info(`No config found; copied example to ${CONFIG_PATH}`);
    }
  } catch (err) {
    // Expected with a read-only config mount: the user copies the example themselves.
    app.log.warn(
      `No config at ${CONFIG_PATH} and it can't be created (${(err as Error).message}). ` +
        'Copy config.example.yaml to config.yaml.',
    );
  }
}

async function loadConfig(): Promise<void> {
  const seq = ++loadSeq;
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    state.error = `Cannot read ${CONFIG_PATH}: ${(err as Error).message}`;
    app.log.error(state.error);
    return;
  }

  const parsed = parseConfig(text);
  if (!parsed.ok) {
    state.error = `Invalid config (${path.basename(CONFIG_PATH)}):\n${parsed.error}`;
    app.log.error(state.error);
    return;
  }

  await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
  const icons = await resolveAllIcons([...parsed.config.services, ...parsed.config.methods, ...parsed.config.groups], { iconsDir: ICONS_DIR, cacheDir: CACHE_DIR, log });
  if (seq !== loadSeq) return; // a newer reload started while icons were resolving

  state.config = toClientConfig(parsed.config, icons);
  dockerHost = parsed.config.dockerHost;
  state.error = null;
  state.version++;
  health.reset();
  app.log.info(`Loaded config v${state.version}: ${parsed.config.services.length} services`);
}

function watchConfig(): FSWatcher | undefined {
  // Watch the directory: editors and bind mounts often replace the file rather than writing in place.
  const dir = path.dirname(CONFIG_PATH);
  const base = path.basename(CONFIG_PATH);
  let timer: NodeJS.Timeout | undefined;
  try {
    return watch(dir, (_event, filename) => {
      if (filename && filename.toString() !== base) return;
      clearTimeout(timer);
      timer = setTimeout(() => void loadConfig(), 300);
    });
  } catch (err) {
    app.log.warn(`Not watching ${dir} for changes: ${(err as Error).message}`);
    return undefined;
  }
}

// --- security headers ------------------------------------------------------
// connect-src stays open: the browser's reachability probes go to any configured URL.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  'connect-src *',
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  // Icon routes set their own, stricter policy.
  if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', PAGE_CSP);
  return payload;
});

// --- routes ----------------------------------------------------------------
app.get('/api/config', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!state.config) reply.code(500);
  return state;
});

// Liveness only: config errors stay in the logs and the page banner, not on an unauthenticated probe.
app.get('/healthz', async () => ({ ok: true, configLoaded: state.config !== null }));

// Server-side HTTP checks. ?fresh=1 (the Re-check button) re-runs them if older than 10s.
app.get<{ Querystring: { fresh?: string } }>('/api/health', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (req.query.fresh) return health.fresh(10_000, 8_000);
  return health.latest;
});

// Future: server-side status scripts live in server/status/ and expose GET /api/status,
// keyed on each service's reserved `status:` config field. Register that route here.

/** Icon routes only serve image files, never hidden files or anything else dropped in the folders. */
const ICON_FILE = /\.(png|svg|webp|jpe?g|gif|ico)$/i;
const iconAllowed = (pathName: string) =>
  ICON_FILE.test(pathName) && !decodeURIComponent(pathName).split('/').some((seg) => seg.startsWith('.'));

const iconHeaders = (reply: FastifyReply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
};

await mkdir(ICONS_DIR, { recursive: true }).catch(() => {});
await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});

await app.register(fastifyStatic, {
  root: ICONS_DIR,
  prefix: '/icons/local/',
  decorateReply: false,
  dotfiles: 'deny',
  allowedPath: iconAllowed,
  maxAge: '1h',
  setHeaders: iconHeaders,
});

await app.register(fastifyStatic, {
  root: CACHE_DIR,
  prefix: '/icons/cache/',
  decorateReply: false,
  dotfiles: 'deny',
  allowedPath: iconAllowed,
  // Cache file names are content-addressed by spec; a changed spec gets a new name.
  maxAge: '7d',
  setHeaders: iconHeaders,
});

if (existsSync(WEB_DIR)) {
  await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/', decorateReply: false });
} else {
  app.log.warn(`Web build not found at ${WEB_DIR}; serving API only (use the Vite dev server).`);
}

// --- start -----------------------------------------------------------------
await ensureConfigFile();
await loadConfig();
const watcher = watchConfig();

const shutdown = async () => {
  watcher?.close();
  health.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: HOST });
