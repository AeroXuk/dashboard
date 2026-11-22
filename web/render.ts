/** DOM building. Config strings only ever go through textContent / attributes, never innerHTML. */
import type { ClientConfig, ClientGroup, ClientMethod, ClientService, ContainerInfo } from '../shared/types';
import { GLYPHS, guessGlyph, isGlyph } from '../shared/glyphs';
import { methodStatus, pickMethod, type ProbeState } from './select';
import { changedFromDefault } from './groups';
import { readJSON, writeJSON } from './storage';

const COLLAPSED_KEY = 'dashboard.collapsedGroups';

export interface ViewState {
  /** service id -> method id -> probe state */
  results: Map<string, Record<string, ProbeState>>;
  /** From the server: serviceId -> method -> HTTP error status. */
  httpErrors: Record<string, Record<string, number>>;
  /** From the server: serviceId -> Docker container state. */
  containers: Record<string, ContainerInfo>;
  pinned: string | null;
  checking: boolean;
}

export interface Handlers {
  onRecheck(): void;
  onTogglePin(method: string): void;
}

export interface AppView {
  update(state: ViewState): void;
  setError(message: string | null): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dot(state: string): HTMLSpanElement {
  const d = el('span', `dot dot-${state}`);
  d.setAttribute('aria-hidden', 'true');
  return d;
}

function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

function avatar(name: string): HTMLSpanElement {
  const a = el('span', 'tile-icon avatar', (name.trim()[0] ?? '?').toUpperCase());
  a.style.setProperty('--hue', String(hueFor(name)));
  a.setAttribute('aria-hidden', 'true');
  return a;
}

function icon(svc: ClientService): HTMLElement {
  if (!svc.icon) return avatar(svc.name);
  const img = el('img', 'tile-icon');
  img.src = svc.icon;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => img.replaceWith(avatar(svc.name)), { once: true });
  return img;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgIcon(paths: readonly string[], className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function glyphIcon(name: string): SVGSVGElement {
  return svgIcon(GLYPHS[isGlyph(name) ? name : 'link'], 'method-icon');
}

/** Icon for an access method: an image from the config, else a built-in glyph. */
function methodIcon(m: ClientMethod): Element {
  if (m.icon) {
    const img = el('img', 'method-icon');
    img.src = m.icon;
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => img.replaceWith(glyphIcon(guessGlyph(m.id, m.label))), { once: true });
    return img;
  }
  return glyphIcon(m.glyph ?? guessGlyph(m.id, m.label));
}

/** Icon for a group heading: an image, a built-in glyph, or nothing. */
function groupIcon(g: ClientGroup): Element | null {
  if (g.icon) {
    const img = el('img', 'group-icon');
    img.src = g.icon;
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove(), { once: true });
    return img;
  }
  if (g.glyph) {
    const svg = glyphIcon(g.glyph);
    svg.setAttribute('class', 'group-icon');
    return svg;
  }
  return null;
}

function linkTo(a: HTMLAnchorElement, newTab: boolean): void {
  if (newTab) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

/**
 * Probe results with the server's HTTP errors applied: a route the browser can reach but which
 * returns an error status (e.g. a proxy's 404 for a stopped container) counts as down.
 */
function effectiveResults(state: ViewState, svcId: string): Record<string, ProbeState> {
  const res = { ...(state.results.get(svcId) ?? {}) };
  for (const m of Object.keys(state.httpErrors[svcId] ?? {})) if (res[m] === 'up') res[m] = 'down';
  return res;
}

// --- Container bookmark ------------------------------------------------------

type BookmarkTone = 'healthy' | 'running' | 'starting' | 'unhealthy' | 'paused' | 'stopped' | 'idle' | 'pending';

/** Colour for a container: healthchecks add starting/unhealthy on top of the plain states. */
export function containerTone(c: ContainerInfo | undefined): BookmarkTone {
  if (!c) return 'pending';
  switch (c.state) {
    case 'running':
      if (c.health === 'healthy') return 'healthy';
      if (c.health === 'unhealthy') return 'unhealthy';
      if (c.health === 'starting') return 'starting';
      return 'running';
    case 'restarting':
      return 'starting';
    case 'paused':
      return 'paused';
    case 'exited':
    case 'dead':
      return 'stopped';
    default:
      return 'idle'; // created, removing, missing, unknown
  }
}

/** A container worth flagging (feeds the Degraded filter). Docker being unreachable is not. */
export function containerHasIssue(c: ContainerInfo | undefined): boolean {
  if (!c) return false;
  return ['exited', 'dead', 'restarting', 'paused', 'missing'].includes(c.state) || c.health === 'unhealthy';
}

function containerSummary(c: ContainerInfo | undefined): string {
  if (!c) return 'Checking…';
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  switch (c.state) {
    case 'running':
      return c.health ? `Running · ${c.health}` : 'Running · no healthcheck';
    case 'missing':
      return 'No container with this name';
    case 'unknown':
      return 'Docker not reachable';
    case 'exited':
      return c.exitCode !== undefined ? `Exited (code ${c.exitCode})` : 'Exited';
    default:
      return cap(c.state);
  }
}

function ago(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  const unit = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return `${unit} ago (${new Date(t).toLocaleString()})`;
}

function buildBookmark(name: string): { node: HTMLElement; update(c: ContainerInfo | undefined): void } {
  const wrap = el('div', 'bookmark-wrap');
  const mark = el('span', 'bookmark');
  mark.tabIndex = 0;
  mark.setAttribute('role', 'img');
  const card = el('div', 'bookmark-card');
  card.setAttribute('role', 'tooltip');
  card.id = `bm-${Math.random().toString(36).slice(2, 9)}`;
  mark.setAttribute('aria-describedby', card.id);
  wrap.append(mark, card);

  const row = (label: string, value: string, cls?: string) => {
    const r = el('div', 'bm-row');
    r.append(el('span', 'bm-k', label), el('span', cls ? `bm-v ${cls}` : 'bm-v', value));
    return r;
  };

  return {
    node: wrap,
    update(c) {
      const tone = containerTone(c);
      wrap.dataset.tone = tone;
      const summary = containerSummary(c);
      mark.setAttribute('aria-label', `Container ${name}: ${summary}`);

      const head = el('div', 'bm-head');
      head.append(el('span', `bm-dot`), el('span', 'bm-title', summary));
      const parts: HTMLElement[] = [head, row('Container', name, 'bm-mono')];
      if (c?.status) parts.push(row('Docker', c.status));
      if (c?.image) parts.push(row('Image', c.image, 'bm-mono'));
      if (c?.state === 'running') {
        const since = ago(c.startedAt);
        if (since) parts.push(row('Started', since));
      } else {
        const when = ago(c?.finishedAt);
        if (when) parts.push(row('Stopped', when));
      }
      if (c?.restartCount) parts.push(row('Restarts', String(c.restartCount)));
      if (c?.failingStreak) parts.push(row('Failing', `${c.failingStreak} check${c.failingStreak === 1 ? '' : 's'} in a row`));
      if (c?.lastCheck) {
        const when = ago(c.lastCheck.at);
        parts.push(row('Last check', `exit ${c.lastCheck.exitCode}${when ? ` · ${when.split(' (')[0]}` : ''}`));
        if (c.lastCheck.output) parts.push(el('pre', 'bm-output', c.lastCheck.output));
      }
      if (c?.error) parts.push(el('div', 'bm-error', c.error));
      card.replaceChildren(...parts);
    },
  };
}

/** Full-page message, used when there is no usable config at all. */
export function renderMessage(root: HTMLElement, title: string, message: string): void {
  const box = el('div', 'fullpage');
  box.append(el('h1', undefined, title), el('pre', 'fullpage-detail', message));
  root.replaceChildren(box);
}

type TileState = 'up' | 'pending' | 'down';

interface TileView {
  node: HTMLElement;
  svc: ClientService;
  status: TileState;
  /** At least one route is red (fails while its method works elsewhere, or returns an HTTP error). */
  degraded: boolean;
  /** dead: methods that are down for every service that uses them. */
  update(state: ViewState, dead: Set<string>): void;
}

/** How a route looks on a tile. "broken" = down while its method works elsewhere; "dead" = method down everywhere. */
type RouteState = 'primary' | 'up' | 'pending' | 'error' | 'broken' | 'dead';
const ROUTE_RANK: Record<RouteState, number> = { primary: 0, up: 1, pending: 2, error: 3, broken: 3, dead: 4 };
const ROUTE_WORD: Record<RouteState, string> = {
  primary: 'in use',
  up: 'reachable',
  pending: 'checking',
  error: 'HTTP error',
  broken: 'not responding',
  dead: 'offline',
};

function buildTile(svc: ClientService, methods: Map<string, ClientMethod>, newTab: boolean): TileView {
  const method = (id: string): ClientMethod => methods.get(id) ?? { id, label: id };
  const node = el('article', 'tile');

  const main = el('a', 'tile-main');
  linkTo(main, newTab);
  const text = el('div', 'tile-text');
  text.append(el('div', 'tile-name', svc.name));
  if (svc.description) text.append(el('div', 'tile-desc', svc.description));
  main.append(icon(svc), text);

  const bookmark = svc.container ? buildBookmark(svc.container) : null;
  if (bookmark) node.classList.add('has-bookmark');

  // Footer bar along the bottom of the tile: one icon chip per route (label on hover),
  // and a "+N" button opening a list of every route when they don't all fit.
  const foot = el('div', 'tile-foot');
  const routes = el('div', 'routes');
  const chips = new Map<string, HTMLAnchorElement>();
  for (const id of svc.order) {
    const m = method(id);
    const a = el('a', 'route');
    a.href = svc.urls[id]!;
    linkTo(a, newTab);
    const ic = methodIcon(m);
    // Image icons change the chip width once loaded; re-measure then.
    if (ic instanceof HTMLImageElement) ic.addEventListener('load', () => fit(), { once: true });
    a.append(ic, el('span', 'route-label', m.label));
    chips.set(id, a);
  }
  routes.append(...chips.values());

  const more = el('button', 'more');
  more.type = 'button';
  more.hidden = true;
  const list = el('ul', 'alts');
  list.hidden = true;
  list.id = `alts-${svc.id}`;
  more.setAttribute('aria-controls', list.id);
  more.setAttribute('aria-expanded', 'false');
  const setOpen = (open: boolean) => {
    list.hidden = !open;
    node.classList.toggle('open', open);
    more.setAttribute('aria-expanded', String(open));
    if (open) {
      // Open towards whichever side has room.
      list.style.left = '0';
      list.style.right = 'auto';
      if (list.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
        list.style.left = 'auto';
        list.style.right = '0';
      }
    }
  };
  more.addEventListener('click', () => setOpen(!node.classList.contains('open')));
  document.addEventListener('click', (e) => {
    if (!list.hidden && !node.contains(e.target as Node)) setOpen(false);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) {
      setOpen(false);
      more.focus();
    }
  });
  foot.append(routes, more);
  node.append(main, foot, list);
  if (bookmark) {
    node.append(bookmark.node);
    bookmark.update(undefined);
  }

  let ordered: string[] = [...svc.order];

  /** Show as many route chips as fit on one line; the rest are counted on the "+N" button. */
  function fit(): void {
    if (!node.isConnected) return;
    const shown = ordered.map((id) => chips.get(id)!);
    for (const chip of shown) chip.hidden = false;
    const total = shown.length;
    const style = getComputedStyle(foot);
    const width = foot.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const gap = parseFloat(getComputedStyle(routes).columnGap) || 0;

    const place = (reserve: number): number => {
      let used = 0;
      let n = 0;
      for (const chip of shown) {
        const w = chip.offsetWidth;
        if (n > 0 && used + w > width - reserve) break; // always keep the first chip
        used += w + gap;
        n++;
      }
      return n;
    };
    let n = place(0);
    if (n < total) {
      more.hidden = false;
      more.textContent = `+${total - n}`;
      n = place(more.offsetWidth + gap);
      more.textContent = `+${total - n}`;
    } else {
      more.hidden = true;
      if (!list.hidden) setOpen(false);
    }
    shown.forEach((chip, i) => (chip.hidden = i >= n));
    more.title = `Show all ${total} routes`;
  }
  new ResizeObserver(() => fit()).observe(foot);

  const view: TileView = {
    node,
    svc,
    status: 'pending',
    degraded: false,
    update(state, dead) {
      const raw = state.results.get(svc.id) ?? {};
      const httpErr = state.httpErrors[svc.id] ?? {};
      const res = effectiveResults(state, svc.id);
      const pick = pickMethod(svc.order, res, state.pinned);
      let primary: string | undefined;
      let tileState: TileState;
      if (pick.kind === 'method') {
        primary = pick.method;
        tileState = 'up';
      } else if (pick.kind === 'pending') {
        primary = pick.tentative;
        tileState = 'pending';
      } else {
        primary = pick.fallback;
        tileState = 'down';
      }
      node.dataset.state = tileState;
      view.status = tileState;
      const href = primary ? svc.urls[primary] : undefined;
      if (href) main.href = href;
      else main.removeAttribute('href');
      main.title = href ?? '';

      const routeState = (id: string): RouteState => {
        if (raw[id] === 'up' && httpErr[id] !== undefined) return 'error';
        const r = res[id] ?? 'pending';
        if (r === 'up') return pick.kind === 'method' && id === pick.method ? 'primary' : 'up';
        if (r === 'pending') return 'pending';
        return dead.has(id) ? 'dead' : 'broken';
      };
      const states = new Map(svc.order.map((id) => [id, routeState(id)] as const));
      const container = state.containers[svc.id];
      bookmark?.update(container);
      view.degraded =
        [...states.values()].some((st) => st === 'broken' || st === 'error') || containerHasIssue(container);
      // Stable sort: primary, other reachable, checking, broken, then methods that are down everywhere.
      ordered = [...svc.order].sort((a, b) => ROUTE_RANK[states.get(a)!] - ROUTE_RANK[states.get(b)!]);
      const word = (id: string, st: RouteState) => (st === 'error' ? `HTTP ${httpErr[id]}` : ROUTE_WORD[st]);
      for (const id of ordered) {
        const chip = chips.get(id)!;
        const st = states.get(id)!;
        chip.dataset.route = st;
        const pinned = state.pinned === id ? ', pinned' : '';
        chip.title = `${method(id).label} (${word(id, st)}${pinned}): ${svc.urls[id]}`;
        chip.setAttribute('aria-label', `${method(id).label}, ${word(id, st)}`);
        routes.append(chip);
      }

      list.replaceChildren(
        ...ordered.map((id) => {
          const st = states.get(id)!;
          const li = el('li');
          const a = el('a', 'alt-link');
          a.href = svc.urls[id]!;
          a.title = svc.urls[id]!;
          a.dataset.route = st;
          linkTo(a, newTab);
          a.append(methodIcon(method(id)), el('span', undefined, method(id).label), el('span', 'alt-state', word(id, st)));
          li.append(a);
          return li;
        }),
      );
      fit();
    },
  };
  return view;
}

export function buildApp(root: HTMLElement, config: ClientConfig, handlers: Handlers): AppView {
  const methods = new Map(config.methods.map((m) => [m.id, m] as const));

  // Header
  const header = el('header', 'top');
  const titleRow = el('div', 'top-row');
  const h1 = el('h1', 'title', config.title);
  const recheck = el('button', 'recheck');
  recheck.type = 'button';
  const spinner = el('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const recheckText = el('span', undefined, 'Re-check');
  recheck.append(spinner, recheckText);
  recheck.addEventListener('click', () => handlers.onRecheck());
  titleRow.append(h1, recheck);

  const chips = el('div', 'chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Access methods (click to prefer)');
  const chipViews = config.methods.map((m) => {
    const chip = el('button', 'chip');
    chip.type = 'button';
    const d = dot('pending');
    const count = el('span', 'chip-count');
    const pin = el('span', 'chip-pin', '★');
    pin.setAttribute('aria-hidden', 'true');
    chip.append(d, methodIcon(m), el('span', 'chip-label', m.label), count, pin);
    chip.addEventListener('click', () => handlers.onTogglePin(m.id));
    chips.append(chip);
    return { id: m.id, label: m.label, chip, d, count };
  });
  header.append(titleRow, chips);

  const banner = el('div', 'banner');
  banner.setAttribute('role', 'alert');
  banner.hidden = true;

  // Toolbar: text search, status filter, expand/collapse all.
  const toolbar = el('div', 'toolbar');
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = 'Filter services…';
  search.setAttribute('aria-label', 'Filter services by name, description or group');
  search.addEventListener('input', () => applyFilter());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      applyFilter();
      search.blur();
    }
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      search.focus();
    }
  });

  type StatusFilter = 'all' | 'up' | 'degraded' | 'down';
  let statusFilter: StatusFilter = 'all';
  const seg = el('div', 'segmented');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Filter by status');
  const segButtons = (
    [
      ['all', 'All'],
      ['up', 'Reachable'],
      ['degraded', 'Degraded'],
      ['down', 'Unreachable'],
    ] as const
  ).map(([value, text]) => {
    const b = el('button', 'seg', text);
    b.type = 'button';
    b.title = {
      all: 'Show every service',
      up: 'Services you can open right now',
      degraded: 'Services that work, but with a red (failing) route or a container problem',
      down: 'Services with no working route',
    }[value];
    b.addEventListener('click', () => {
      statusFilter = value;
      for (const [v, btn] of segButtons) btn.setAttribute('aria-pressed', String(v === statusFilter));
      applyFilter();
    });
    return [value, b] as const;
  });
  for (const [v, b] of segButtons) {
    b.setAttribute('aria-pressed', String(v === statusFilter));
    seg.append(b);
  }

  const toggleAll = el('button', 'toggle-all');
  toggleAll.type = 'button';
  const resetGroups = el('button', 'toggle-all', 'Reset');
  resetGroups.type = 'button';
  resetGroups.title = 'Expand and collapse groups as set in the config';
  resetGroups.setAttribute('aria-label', 'Reset groups to their default');
  toolbar.append(search, seg, toggleAll, resetGroups);
  header.append(toolbar);

  // Groups: ungrouped first (no heading), then named groups in config order.
  // Collapsed state: the config sets the default, and each browser remembers its own choice.
  const main = el('main', 'groups');
  const saved = readJSON<Record<string, boolean>>(COLLAPSED_KEY, {});
  const tiles: TileView[] = [];

  interface SectionView {
    section: HTMLElement;
    grid: HTMLElement;
    tiles: TileView[];
    count?: HTMLElement;
    named: boolean;
    /** Saved per browser and used under every filter. */
    collapsed: boolean;
    btn?: HTMLButtonElement;
    name?: string;
  }
  const sections: SectionView[] = [];

  const isCollapsed = (v: SectionView) => v.named && v.collapsed;
  /** Collapse or expand a group: one state for every filter, remembered per browser. */
  const setCollapsed = (v: SectionView, c: boolean) => {
    v.collapsed = c;
    saved[v.name!] = c;
  };

  const makeSection = (services: ClientService[], id: string): SectionView => {
    const section = el('section', 'group');
    const grid = el('div', 'grid');
    grid.id = id;
    const own = services.map((svc) => buildTile(svc, methods, config.settings.openInNewTab));
    for (const t of own) grid.append(t.node);
    tiles.push(...own);
    main.append(section);
    const view: SectionView = { section, grid, tiles: own, named: false, collapsed: false };
    sections.push(view);
    return view;
  };

  const ungrouped = config.services.filter((svc) => svc.group === undefined);
  if (ungrouped.length) {
    const v = makeSection(ungrouped, 'group-ungrouped');
    v.section.append(v.grid);
  }

  config.groups.forEach((g, i) => {
    const v = makeSection(
      config.services.filter((svc) => svc.group === g.name),
      `group-${i}`,
    );
    const heading = el('h2', 'group-title');
    const btn = el('button', 'group-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-controls', v.grid.id);
    v.count = el('span', 'group-count');
    const gi = groupIcon(g);
    btn.append(svgIcon(['M9 6l6 6-6 6'], 'chevron'), ...(gi ? [gi] : []), el('span', 'group-name', g.label), v.count);
    heading.append(btn);
    v.section.append(heading, v.grid);

    v.named = true;
    v.name = g.name;
    v.btn = btn;
    v.collapsed = saved[g.name] ?? g.collapsed;
    btn.addEventListener('click', () => {
      setCollapsed(v, !isCollapsed(v));
      writeJSON(COLLAPSED_KEY, saved);
      applyFilter();
    });
  });

  const noMatches = el('p', 'empty', 'No services match the filter.');
  noMatches.hidden = true;
  main.append(noMatches);

  const namedSections = sections.filter((x) => x.named);
  const groupLabels = new Map(config.groups.map((g) => [g.name, g.label] as const));
  toggleAll.hidden = namedSections.length === 0;
  toggleAll.addEventListener('click', () => {
    // Only groups currently on screen count (a filter can hide whole groups).
    const visible = namedSections.filter((x) => !x.section.hidden);
    const collapse = visible.some((x) => !isCollapsed(x));
    for (const x of visible) setCollapsed(x, collapse);
    writeJSON(COLLAPSED_KEY, saved);
    applyFilter();
  });

  // Reset: back to the config's defaults for every group, including ones a filter hides.
  resetGroups.addEventListener('click', () => {
    for (const key of Object.keys(saved)) delete saved[key];
    for (const g of config.groups) {
      const v = namedSections.find((x) => x.name === g.name);
      if (v) v.collapsed = g.collapsed;
    }
    writeJSON(COLLAPSED_KEY, saved);
    applyFilter();
    toggleAll.focus();
  });

  /**
   * Show matching tiles. Groups keep their collapsed state under every filter; a group's
   * heading shows how many of its services match, so collapsed matches are still visible.
   */
  function applyFilter(): void {
    const q = search.value.trim().toLowerCase();
    const filtering = q !== '' || statusFilter !== 'all';
    let total = 0;
    for (const sec of sections) {
      let shown = 0;
      for (const t of sec.tiles) {
        const group = t.svc.group ?? '';
        const text = `${t.svc.name} ${t.svc.description ?? ''} ${group} ${groupLabels.get(group) ?? ''}`.toLowerCase();
        const statusOk =
          statusFilter === 'all' ||
          (statusFilter === 'up' && t.status === 'up') ||
          (statusFilter === 'degraded' && t.status === 'up' && t.degraded) ||
          (statusFilter === 'down' && t.status === 'down');
        const ok = (!q || text.includes(q)) && statusOk;
        t.node.hidden = !ok;
        if (ok) shown++;
      }
      total += shown;
      sec.section.hidden = shown === 0;
      const collapsed = isCollapsed(sec);
      sec.grid.hidden = collapsed;
      sec.section.classList.toggle('collapsed', collapsed);
      sec.btn?.setAttribute('aria-expanded', String(!collapsed));
      if (sec.count) sec.count.textContent = filtering ? `${shown}/${sec.tiles.length}` : String(sec.tiles.length);
    }
    noMatches.hidden = total > 0 || config.services.length === 0;
    const visibleNamed = namedSections.filter((x) => !x.section.hidden);
    const anyOpen = visibleNamed.some((x) => !isCollapsed(x));
    toggleAll.disabled = visibleNamed.length === 0;
    toggleAll.textContent = anyOpen ? 'Collapse all' : 'Expand all';
    toggleAll.setAttribute('aria-label', anyOpen ? 'Collapse all groups' : 'Expand all groups');
    resetGroups.hidden = !changedFromDefault(
      config.groups,
      Object.fromEntries(namedSections.map((x) => [x.name!, x.collapsed])),
    );
    toolbar.classList.toggle('filtering', filtering);
    main.classList.toggle('filtering', filtering);
  }

  if (config.services.length === 0) {
    main.append(el('p', 'empty', 'No services configured yet. Add some under services: in config.yaml.'));
    toolbar.hidden = true;
  }
  applyFilter();

  root.replaceChildren(header, banner, main);

  return {
    update(state) {
      recheck.disabled = state.checking;
      recheck.classList.toggle('busy', state.checking);
      recheckText.textContent = state.checking ? 'Checking…' : 'Re-check';

      const dead = new Set<string>();
      for (const c of chipViews) {
        const states: ProbeState[] = [];
        const reachable: ProbeState[] = [];
        for (const svc of config.services) {
          if (svc.probeUrls[c.id] === undefined) continue;
          reachable.push(state.results.get(svc.id)?.[c.id] ?? 'pending');
          states.push(effectiveResults(state, svc.id)[c.id] ?? 'pending');
        }
        // Counts show routes that work; the method is only "down everywhere" if nothing answered at all.
        const st = methodStatus(states);
        const connected = methodStatus(reachable);
        const pinned = state.pinned === c.id;
        c.d.className = `dot dot-${st.status === 'online' ? 'up' : st.status === 'offline' ? 'down' : st.status}`;
        c.count.textContent = st.total ? `${st.up}/${st.total}` : '–';
        c.chip.dataset.status = st.status;
        if (connected.status === 'offline') dead.add(c.id);
        c.chip.classList.toggle('pinned', pinned);
        c.chip.setAttribute('aria-pressed', String(pinned));
        const word = { online: 'online', offline: 'offline', checking: 'checking', unused: 'no services' }[st.status];
        c.chip.title = `${c.label}: ${word} (${st.up}/${st.total} reachable). ${pinned ? 'Click to unpin.' : 'Click to prefer this method.'}`;
      }
      for (const t of tiles) t.update(state, dead);
      applyFilter();
    },
    setError(message) {
      banner.hidden = !message;
      banner.textContent = message ?? '';
    },
  };
}
