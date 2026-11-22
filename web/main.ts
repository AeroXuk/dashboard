import type { ClientConfig, ConfigResponse, HealthResponse } from '../shared/types';
import { ProbeRound } from './probe';
import { buildApp, renderMessage, type AppView, type ViewState } from './render';
import type { ProbeState } from './select';
import './styles.css';

const PIN_KEY = 'dashboard.pinnedMethod';
const VISIBLE_RECHECK_MS = 10_000;

function readPin(): string | null {
  try {
    return localStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
}

function writePin(value: string | null): void {
  try {
    if (value) localStorage.setItem(PIN_KEY, value);
    else localStorage.removeItem(PIN_KEY);
  } catch {
    /* storage unavailable: the pin lasts for this page view only */
  }
}

const root = document.getElementById('app')!;
let config: ClientConfig | null = null;
let version = -1;
let view: AppView | null = null;
let configError: string | null = null;
let lastRoundAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const state: ViewState = { results: new Map(), httpErrors: {}, containers: {}, pinned: readPin(), checking: false };

let frame = 0;
function render(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    view?.update(state);
  });
}

async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch('/api/config', { cache: 'no-store' });
  try {
    return (await res.json()) as ConfigResponse;
  } catch {
    throw new Error(`Dashboard server returned HTTP ${res.status}`);
  }
}

/** The server's own checks: HTTP status codes the browser can't see, and Docker container state. */
async function fetchHealth(fresh: boolean): Promise<void> {
  if (!config || !(config.settings.httpCheck || config.services.some((s) => s.container))) return;
  try {
    const res = await fetch(`/api/health${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
    const body = (await res.json()) as HealthResponse;
    if (body.enabled) {
      state.httpErrors = body.errors;
      state.containers = body.containers ?? {};
      render();
    }
  } catch {
    /* keep the previous results */
  }
}

function runRound(manual = false): void {
  if (!config) return;
  const round = new ProbeRound(config.settings.probeTimeoutMs);
  lastRoundAt = Date.now();
  state.checking = true;
  render();
  const jobs: Promise<void>[] = [];
  for (const svc of config.services) {
    const res = state.results.get(svc.id)!;
    for (const [method, url] of Object.entries(svc.probeUrls)) {
      jobs.push(
        round.check(url, (up) => {
          res[method] = up ? 'up' : 'down';
          render();
        }),
      );
    }
  }
  jobs.push(fetchHealth(manual));
  void Promise.all(jobs).then(() => {
    if (!round.active) return;
    state.checking = false;
    render();
  });
}

function applyConfig(resp: ConfigResponse): void {
  configError = resp.error ? `Config problem: ${resp.error}` : null;
  if (!resp.config) {
    ProbeRound.invalidate();
    config = null;
    view = null;
    version = resp.version;
    document.title = 'Dashboard';
    renderMessage(root, 'Dashboard config unavailable', resp.error ?? 'No configuration loaded.');
    schedule();
    return;
  }
  if (resp.version === version && view) {
    view.setError(configError);
    runRound();
    return;
  }
  version = resp.version;
  config = resp.config;
  state.httpErrors = {};
  state.containers = {};
  document.title = config.title;
  state.results = new Map(
    config.services.map((s) => [
      s.id,
      Object.fromEntries(Object.keys(s.probeUrls).map((m) => [m, 'pending' as ProbeState])),
    ]),
  );
  view = buildApp(root, config, {
    onRecheck: () => runRound(true),
    onTogglePin(method) {
      state.pinned = state.pinned === method ? null : method;
      writePin(state.pinned);
      render();
    },
  });
  view.setError(configError);
  view.update(state);
  schedule();
  runRound();
}

async function refresh(): Promise<void> {
  try {
    applyConfig(await fetchConfig());
  } catch (err) {
    const msg = `Could not reach the dashboard server (${(err as Error).message}).`;
    if (view) {
      view.setError(msg);
      runRound();
    } else {
      renderMessage(root, 'Dashboard unavailable', msg);
      schedule();
    }
  }
}

function schedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  // With no usable config, keep retrying so a fixed config file shows up on its own.
  const sec = config ? config.settings.reprobeIntervalSec : 15;
  if (sec > 0) timer = setInterval(() => void refresh(), sec * 1000);
}

window.addEventListener('online', () => runRound());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRoundAt > VISIBLE_RECHECK_MS) void refresh();
});

void refresh();
