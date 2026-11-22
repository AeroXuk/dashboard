/** Shapes shared between the server (/api/config) and the browser. */

export interface ClientMethod {
  id: string;
  label: string;
  /** Built-in inline icon name (see shared/glyphs.ts). */
  glyph?: string;
  /** Local path served by the dashboard (/icons/...) for an image icon. */
  icon?: string;
}

export interface ClientService {
  id: string;
  name: string;
  description?: string;
  group?: string;
  /** Local path served by the dashboard (/icons/...), or undefined for a letter avatar. */
  icon?: string;
  /** Fallback order for this service, limited to methods it has a URL for. */
  order: string[];
  /** method id -> URL the tile links to */
  urls: Record<string, string>;
  /** method id -> URL the browser probes for reachability */
  probeUrls: Record<string, string>;
  /** Docker container name whose state the server reports. */
  container?: string;
}

export interface ClientGroup {
  /** Key that services refer to with `group:`. */
  name: string;
  /** Display name for the heading; defaults to the name. */
  label: string;
  /** Default state from the config; each browser can override it. */
  collapsed: boolean;
  /** Built-in inline icon name (see shared/glyphs.ts). */
  glyph?: string;
  /** Local path served by the dashboard (/icons/...) for an image icon. */
  icon?: string;
}

export interface ClientConfig {
  title: string;
  settings: {
    probeTimeoutMs: number;
    reprobeIntervalSec: number;
    openInNewTab: boolean;
    /** The server also requests each URL to catch HTTP errors the browser can't see. */
    httpCheck: boolean;
    /** HTTP statuses >= 400 that still count as working (e.g. login prompts). */
    httpOkStatuses: number[];
  };
  /** All methods, in global fallback order. */
  methods: ClientMethod[];
  /** Named groups that have services, in display order. Ungrouped services come first. */
  groups: ClientGroup[];
  services: ClientService[];
}

export interface ConfigResponse {
  /** Increments every time the config file is reloaded successfully. */
  version: number;
  config: ClientConfig | null;
  /** Set when the config file is missing or invalid. The last good config is still served. */
  error: string | null;
}

export type ContainerState =
  | 'running'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'created'
  | 'dead'
  | 'removing'
  /** No container with that name. */
  | 'missing'
  /** Docker couldn't be asked (see error). */
  | 'unknown';

export interface ContainerInfo {
  name: string;
  state: ContainerState;
  /** Only for containers with a healthcheck. */
  health?: 'healthy' | 'unhealthy' | 'starting';
  /** Docker's own summary, e.g. "Up 3 hours (healthy)". */
  status?: string;
  image?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  restartCount?: number;
  failingStreak?: number;
  /** Most recent healthcheck run. */
  lastCheck?: { exitCode: number; output: string; at: string };
  error?: string;
}

/** GET /api/health: results of the server's own checks. */
export interface HealthResponse {
  enabled: boolean;
  /** Epoch ms of the last completed check, or null before the first one. */
  checkedAt: number | null;
  /** serviceId -> method -> HTTP status, only for URLs that returned an error status. */
  errors: Record<string, Record<string, number>>;
  /** serviceId -> container state, for services with `container:`. */
  containers: Record<string, ContainerInfo>;
}
