import { z } from 'zod';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { ClientConfig, ClientGroup, ClientMethod, ClientService } from '../shared/types.js';
import { guessGlyph, isGlyph } from '../shared/glyphs.js';

const METHOD_NAME = /^[A-Za-z0-9_-]+$/;

const httpUrl = z.string().refine(
  (v) => {
    if (!URL.canParse(v)) return false;
    const p = new URL(v).protocol;
    return p === 'http:' || p === 'https:';
  },
  { message: 'must be an http:// or https:// URL' },
);

const MethodSchema = z
  .object({
    label: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  })
  .strict()
  .nullish();

const ServiceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    icon: z.string().optional(),
    group: z.string().optional(),
    order: z.array(z.string()).optional(),
    probe: z.string().optional(),
    urls: z.record(z.string(), httpUrl),
    /** Docker container name; the server reports its state. */
    container: z.string().min(1).optional(),
    /** Reserved for future server-side status scripts. Accepted and ignored for now. */
    status: z.unknown().optional(),
  })
  .strict();

const SettingsSchema = z
  .object({
    probeTimeoutMs: z.number().int().positive().optional(),
    reprobeIntervalSec: z.number().min(0).optional(),
    openInNewTab: z.boolean().optional(),
    httpCheck: z.boolean().optional(),
    httpOkStatuses: z.array(z.number().int().min(100).max(599)).optional(),
  })
  .strict()
  .nullish();

const GroupSchema = z
  .object({
    label: z.string().min(1).optional(),
    icon: z.string().optional(),
    collapsed: z.boolean().optional(),
  })
  .strict()
  .nullish();

const DockerSchema = z
  .object({
    /** unix:///var/run/docker.sock, tcp://host:2375 or http(s)://host:port. */
    host: z.string().min(1).optional(),
  })
  .strict()
  .nullish();

const RootSchema = z
  .object({
    title: z.string().optional(),
    settings: SettingsSchema,
    methods: z.record(z.string(), MethodSchema),
    groups: z.record(z.string(), GroupSchema).nullish(),
    docker: DockerSchema,
    services: z.array(ServiceSchema).nullish(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const known = new Set(Object.keys(cfg.methods));
    if (known.size === 0) {
      ctx.addIssue({ code: 'custom', path: ['methods'], message: 'at least one method is required' });
    }
    for (const id of known) {
      if (!METHOD_NAME.test(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['methods', id],
          message: 'method names may only contain letters, digits, "_" and "-"',
        });
      }
    }
    const checkOrder = (order: string[] | undefined, path: (string | number)[]) => {
      if (!order) return;
      const seen = new Set<string>();
      order.forEach((m, i) => {
        if (!known.has(m)) {
          ctx.addIssue({ code: 'custom', path: [...path, i], message: `unknown method "${m}"` });
        } else if (seen.has(m)) {
          ctx.addIssue({ code: 'custom', path: [...path, i], message: `duplicate method "${m}"` });
        }
        seen.add(m);
      });
    };
    (cfg.services ?? []).forEach((svc, i) => {
      const keys = Object.keys(svc.urls);
      if (keys.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['services', i, 'urls'], message: 'at least one URL is required' });
      }
      for (const m of keys) {
        if (!known.has(m)) {
          ctx.addIssue({ code: 'custom', path: ['services', i, 'urls', m], message: `unknown method "${m}"` });
        }
      }
      checkOrder(svc.order, ['services', i, 'order']);
      if (svc.probe !== undefined) {
        for (const [m, url] of Object.entries(svc.urls)) {
          if (!URL.canParse(svc.probe, url)) {
            ctx.addIssue({
              code: 'custom',
              path: ['services', i, 'probe'],
              message: `cannot be resolved against the "${m}" URL`,
            });
            break;
          }
        }
      }
    });
  });

/** A service as held by the server: the client shape plus the raw icon spec. */
export interface ServerService extends ClientService {
  iconSpec?: string;
}

/** A method as held by the server: the client shape plus the raw (non-built-in) icon spec. */
export interface ServerMethod extends ClientMethod {
  iconSpec?: string;
}

/** A group as held by the server: the client shape plus the raw (non-built-in) icon spec. */
export interface ServerGroup extends ClientGroup {
  iconSpec?: string;
}

export interface ServerConfig extends Omit<ClientConfig, 'services' | 'methods' | 'groups'> {
  methods: ServerMethod[];
  groups: ServerGroup[];
  services: ServerService[];
  /** docker.host from the config; the server falls back to DOCKER_HOST or the local socket. */
  dockerHost?: string;
}

export type ParseResult = { ok: true; config: ServerConfig } | { ok: false; error: string };

export const DEFAULT_SETTINGS = {
  probeTimeoutMs: 2500,
  reprobeIntervalSec: 60,
  openInNewTab: true,
  httpCheck: true,
  httpOkStatuses: [401, 403],
} as const;

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '(root)';
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'service';
}

/** Keys of a top-level YAML mapping, in the order they are written (JS objects reorder numeric keys). */
function keyOrder(doc: ReturnType<typeof parseDocument>, key: string): string[] {
  const node = doc.get(key, true);
  if (!isMap(node)) return [];
  return node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
}

/** Parse and validate YAML text, then normalise it. Pure: no I/O. */
export function parseConfig(yamlText: string): ParseResult {
  const doc = parseDocument(yamlText);
  if (doc.errors.length) {
    return { ok: false, error: `YAML syntax error: ${doc.errors[0]!.message}` };
  }
  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'config must be a YAML mapping (with at least "methods" and "services")' };
  }
  // Friendly errors for the older config shapes.
  const r = raw as Record<string, unknown>;
  if ('order' in r) {
    return {
      ok: false,
      error: 'order: no longer used. Methods are tried in the order they are listed under methods: (move them to reorder).',
    };
  }
  if (Array.isArray(r.groups)) {
    return {
      ok: false,
      error: 'groups: is now a mapping like methods:, e.g.\n  groups:\n    Media:\n      label: Movies & TV\n      icon: film',
    };
  }

  const result = RootSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`);
    return { ok: false, error: lines.join('\n') };
  }
  const cfg = result.data;

  // Methods are tried in the order they are written under methods:.
  const globalOrder = keyOrder(doc, 'methods').filter((id) => id in cfg.methods);

  const methods: ServerMethod[] = globalOrder.map((id) => {
    const label = cfg.methods[id]?.label ?? id;
    const icon = cfg.methods[id]?.icon;
    if (icon === undefined) return { id, label, glyph: guessGlyph(id, label) };
    if (isGlyph(icon)) return { id, label, glyph: icon };
    return { id, label, iconSpec: icon };
  });

  const usedIds = new Set<string>();
  const services: ServerService[] = (cfg.services ?? []).map((svc) => {
    const base = slugify(svc.name);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    const urls: Record<string, string> = { ...svc.urls };
    const order = (svc.order ?? globalOrder).filter((m) => m in urls);
    const probeUrls: Record<string, string> = {};
    for (const [m, url] of Object.entries(urls)) {
      probeUrls[m] = svc.probe !== undefined ? new URL(svc.probe, url).href : url;
    }

    const out: ServerService = { id, name: svc.name, order, urls, probeUrls };
    if (svc.description !== undefined) out.description = svc.description;
    if (svc.group !== undefined) out.group = svc.group;
    if (svc.icon !== undefined) out.iconSpec = svc.icon;
    if (svc.container !== undefined) out.container = svc.container;
    return out;
  });

  // Groups: those under groups: first (in the order written), then any others in order of
  // first use. Listed groups with no services are skipped.
  const used = new Set(services.map((s) => s.group).filter((g): g is string => g !== undefined));
  const groups: ServerGroup[] = [];
  for (const name of keyOrder(doc, 'groups')) {
    if (!used.has(name)) continue;
    const g = cfg.groups?.[name] ?? {};
    const out: ServerGroup = { name, label: g.label ?? name, collapsed: g.collapsed ?? false };
    if (g.icon !== undefined) {
      if (isGlyph(g.icon)) out.glyph = g.icon;
      else out.iconSpec = g.icon;
    }
    groups.push(out);
  }
  for (const name of used) if (!groups.some((g) => g.name === name)) groups.push({ name, label: name, collapsed: false });

  const settings = cfg.settings ?? {};
  return {
    ok: true,
    config: {
      title: cfg.title ?? 'Dashboard',
      settings: {
        probeTimeoutMs: settings.probeTimeoutMs ?? DEFAULT_SETTINGS.probeTimeoutMs,
        reprobeIntervalSec: settings.reprobeIntervalSec ?? DEFAULT_SETTINGS.reprobeIntervalSec,
        openInNewTab: settings.openInNewTab ?? DEFAULT_SETTINGS.openInNewTab,
        httpCheck: settings.httpCheck ?? DEFAULT_SETTINGS.httpCheck,
        httpOkStatuses: settings.httpOkStatuses ?? [...DEFAULT_SETTINGS.httpOkStatuses],
      },
      methods,
      groups,
      services,
      dockerHost: cfg.docker?.host,
    },
  };
}

/** Strip server-only fields and attach resolved icon paths. */
export function toClientConfig(cfg: ServerConfig, icons: Map<string, string | undefined> = new Map()): ClientConfig {
  const { dockerHost: _dockerHost, ...rest } = cfg; // server-only
  return {
    ...rest,
    methods: cfg.methods.map(({ iconSpec, ...m }) => {
      if (iconSpec === undefined) return m;
      const icon = icons.get(iconSpec);
      // An image icon that couldn't be resolved falls back to a guessed built-in.
      return icon ? { ...m, icon } : { ...m, glyph: guessGlyph(m.id, m.label) };
    }),
    groups: cfg.groups.map(({ iconSpec, ...g }) => {
      const icon = iconSpec !== undefined ? icons.get(iconSpec) : undefined;
      return icon ? { ...g, icon } : g;
    }),
    services: cfg.services.map(({ iconSpec, ...svc }) => {
      const icon = iconSpec !== undefined ? icons.get(iconSpec) : undefined;
      return icon ? { ...svc, icon } : svc;
    }),
  };
}
