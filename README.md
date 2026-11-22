# Dashboard

A small self-hosted start page for the services on a home server. Everything is configured in one YAML file, and there is no login.

- **Tiles:** each service gets a tile with an icon, a name and a short description, sorted into collapsible groups.
- **Several ways to reach each service:** you list a service's URLs under named **access methods** (for example LAN, Tailscale, public). Your browser checks which ones it can reach right now, and each tile links through the first one that works.
- **Health at a glance:**
  - Routes that fail are marked on the tile.
  - The server also catches HTTP errors, such as a proxy's 404 for a stopped app.
  - A coloured bookmark shows each service's Docker container state.

## Install

The image is published to GitHub Container Registry as `ghcr.io/aeroxuk/dashboard`, for linux/amd64 and linux/arm64.

```bash
mkdir dashboard && cd dashboard
mkdir -p config icons data
sudo chown 1000:1000 data        # the container runs as uid 1000 and caches icons here

curl -fsSLO https://raw.githubusercontent.com/AeroXuk/dashboard/main/docker-compose.yml
docker run --rm ghcr.io/aeroxuk/dashboard:latest cat /app/config/config.example.yaml > config/config.yaml

docker compose up -d
```

Open `http://<server>:3000` and edit `config/config.yaml`. Saved changes are picked up without a restart.

| Folder     | Mounted at | Mode       | Holds |
|------------|------------|------------|-------|
| `./config` | `/config`  | read-only  | `config.yaml` |
| `./icons`  | `/icons`   | read-only  | your own icon images |
| `./data`   | `/data`    | read-write | downloaded icons (`icon-cache/`) |

**Versions:** `:latest` is the newest release. `:1`, `:1.2` and `:1.2.0` let you pin a major, minor or exact version. To update:

```bash
docker compose pull && docker compose up -d
```

If the package is private, run `docker login ghcr.io` first with a GitHub token that has `read:packages`.

## Configuration

A complete example:

```yaml
title: Home Server

settings:                     # all optional; defaults shown
  probeTimeoutMs: 2500        # how long the browser waits for each URL
  reprobeIntervalSec: 60      # re-check interval; 0 = only on load, network change or Re-check
  openInNewTab: true
  httpCheck: true             # the server also checks HTTP status codes
  httpOkStatuses: [401, 403]  # error statuses that still count as working (login prompts)

# Access methods, in fallback order: each tile links through the first one that answers.
methods:
  local:
    label: LAN
    icon: home
  tailnet:
    label: Tailscale
    icon: tailscale
  public:
    label: Public
    icon: cloudflare

# Groups, in display order. Services refer to them by key.
groups:
  media:
    label: Media
    icon: film
  admin:
    label: Admin
    icon: server
    collapsed: true

services:
  - name: Jellyfin
    description: Movies and TV
    icon: jellyfin
    group: media
    container: jellyfin
    urls:
      local: http://10.0.0.10:8096
      tailnet: https://jellyfin.example.ts.net
      public: https://jellyfin.example.com

  - name: Router
    description: Network controller
    icon: unifi
    group: admin
    order: [public, local]    # this tile prefers public
    probe: /status            # check this path instead of the page itself
    urls:
      local: https://10.0.0.1
      public: https://unifi.example.com

# Optional: where to read container status from (see Container status).
# docker:
#   host: tcp://docker-proxy:2375
```

Invalid config is reported on the page, and the last valid config stays in use until you fix it.

### Top level

| Key        | Required | |
|------------|----------|-|
| `title`    | no       | Page title. |
| `settings` | no       | See the example above. Every setting has a default. |
| `methods`  | yes      | Access methods, **in fallback order**. Keys may use letters, digits, `_` and `-`. Each one takes optional `label` and `icon`; an empty entry (`local:`) is fine. |
| `groups`   | no       | Groups, **in display order**. Each one takes optional `label` (the heading; defaults to the key), `icon` and `collapsed`. Groups you don't list follow in order of first use. Services with no group come first, without a heading. |
| `docker`   | no       | `host`: the Docker API address for container status. |
| `services` | yes      | List of services. |

### Services

| Key           | Required | |
|---------------|----------|-|
| `name`        | yes      | Tile title. |
| `urls`        | yes      | Method key → URL (`http` or `https`), at least one. |
| `description` | no       | Text under the name. |
| `icon`        | no       | See [Icons](#icons). Without one, the tile shows a coloured letter. |
| `group`       | no       | A group key. |
| `order`       | no       | Fallback order for this tile only, e.g. `[tailnet, local]`. |
| `probe`       | no       | Path to check instead of the URL itself, resolved against each URL (`/health` replaces the path; `health` is appended to it). |
| `container`   | no       | Docker container name. See [Container status](#container-status). |

### Icons

Service, method and group icons all accept the same values:

| Value | Source |
|-------|--------|
| `jellyfin` | A name from [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons). |
| `my-app.png` | A file in `./icons` (`.png .svg .webp .jpg .jpeg .gif .ico`). |
| `https://example.com/logo.svg` | Any image URL. |
| `home` | A built-in icon. These are: `home` `lan` `wifi` `vpn` `globe` `cloud` `lock` `server` `link` `film` `tv` `music` `download` `cog` `chart` `camera` `database` `book` `tools` `cpu`. |

CDN and URL icons are downloaded once into `./data/icon-cache` and served by the dashboard itself, so your browser never contacts a third party. A method without an icon gets a built-in one chosen from its name:

| Method name contains | Icon |
|---|---|
| lan, local, home | `home` |
| tail, vpn, wireguard | `vpn` |
| public, cloudflare, tunnel | `globe` |

## How it works

**Route checks (your browser).** Your browser requests every service URL in `no-cors` mode, so services need no CORS setup. Any reply means the route is reachable; a network error, timeout or rejected certificate means it isn't.
- In the header, a method counts as online when at least one of its URLs answers. Each method shows how many of its URLs answered.
- Each tile links through the first reachable method in its order.
- Checks re-run:
  - on load
  - when the network reconnects
  - when the tab becomes visible again
  - every `reprobeIntervalSec`
  - on **Re-check**
- Click a method in the header to prefer it in this browser.

**HTTP checks (the server).** A `no-cors` request can't see status codes, so a reverse proxy answering `404` or `502` for a stopped app would look fine. With `httpCheck` on, the server also requests each URL and reports error statuses, apart from those in `httpOkStatuses`. That route turns red with its code, and the tile falls back to its next route.

The server can only check URLs it can reach itself; for anything else, the browser's result stands.

**Route icons** sit in a bar along the bottom of each tile; hover one to see its label. Routes that don't fit are behind **+N**, which lists every route with its status.

| Look | Meaning |
|------|---------|
| blue outline | the route the tile is using |
| plain | reachable |
| red | fails while that method works for other services, or returns an HTTP error |
| grey | the method is down for every service (e.g. you're not on that network) |

### Container status

Give a service `container: <name>` and a bookmark hangs over the tile's top-right corner, coloured by the container's state. Hover it, or tab to it, for details:
- Docker's status line
- the image
- uptime, or the exit code
- the restart count
- for containers with a healthcheck: how many checks in a row have failed, and the last check's output

| Colour | State |
|--------|-------|
| green  | running, healthcheck healthy |
| teal   | running, no healthcheck |
| amber  | healthcheck starting, or restarting |
| orange | unhealthy |
| slate  | paused |
| red    | exited or dead |
| grey   | created, no such container, or Docker not reachable |

The bundled compose file runs [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) next to the dashboard. The proxy only allows reading container information, and the dashboard reaches it at `DOCKER_HOST=tcp://docker-proxy:2375`.

If your containers run on another machine:
1. Run the proxy on that machine, publishing port 2375 to your LAN only.
2. Set `docker.host: tcp://<that-machine>:2375` in the config.

Only one Docker host is supported.

## Using the page

- **Search:** press `/` to jump to the search box, and `Esc` to clear it. It matches service names, descriptions and groups.
- **Status filters:**
  - **All**
  - **Reachable**
  - **Degraded:** the service works, but has a red route or a container problem (stopped, restarting, paused, unhealthy or missing)
  - **Unreachable:** no route works
- **Groups:** click a heading to collapse or expand it, or use **Collapse all / Expand all**. Each browser remembers its choice under every filter. Once any group differs from its `collapsed` setting in the config, a **Reset** button appears next to it and puts every group back. Headings show how many services match the current filter.

## Security

The dashboard has **no login**. Anyone who can reach it sees your service URLs, internal addresses and container names, so put it behind an access proxy (e.g. Cloudflare Access) if it's reachable from outside your network.

**What it serves (GET and HEAD only):**

| Path | |
|------|-|
| `/`, `/assets/*` | the web page |
| `/api/config` | the parsed config (minus `docker.host`) |
| `/api/health` | HTTP error statuses and container state (`?fresh=1` re-runs the checks, at most every 10 s) |
| `/healthz` | liveness: `{"ok":true,"configLoaded":true}` |
| `/icons/local/*`, `/icons/cache/*` | image files only; hidden files and other file types return 404 |

**In place:**
- **Visitor input is never used to decide what the server contacts.** The server only requests URLs from your config. Visitors can't change anything, and config text is only ever shown as plain text.
- **Security headers:**
  - every response: `nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`
  - the page: a Content Security Policy allowing only its own scripts and styles. `connect-src` stays open because the browser checks your service URLs.
  - icons: `default-src 'none'`, so a tampered SVG can't run scripts
- **Container hardening in the compose file:**
  - both containers: read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, memory and process limits
  - the dashboard: runs as uid 1000
  - the Docker proxy: an internal network with no internet access, not published on the host, read access to containers only
  - healthchecks: the dashboard checks `/healthz`, the proxy checks it can reach Docker, and the dashboard waits for the proxy to be healthy before starting
- **Mounts:** config and icons are mounted read-only.

**Trade-off:** the proxy's container access includes inspect, which returns each container's environment variables. The dashboard only passes on the status fields above, but a compromised dashboard could read those variables.

## Browser limitations

- **Mixed content:** opened over `https` (e.g. through a tunnel), the page can't check `http://` URLs, so those routes show offline. The exception is Chrome, with its Local Network Access feature. There the page marks these checks as local-network requests, and after you allow Chrome's prompt to access devices on your local network, `http://` URLs on your LAN can be checked. Other browsers still show them offline.
- **Local network access:** Chrome may ask for permission before a public page can reach private IP addresses. If you block it, LAN routes show offline; you can change it later in the site settings.
- **Certificates:** a self-signed or mismatched certificate fails the check until the browser trusts it. Tailscale IPs fail with a certificate issued for a `.ts.net` hostname, for example.
- **Tip:** also open the dashboard on each network (e.g. `http://<server-lan-ip>:3000` on the LAN, or its Tailscale name) and bookmark the one that fits where you are. The page and its checks then use the same scheme.

## Development

```bash
npm install
npm run dev          # http://localhost:5173: Vite proxies /api and /icons to the server on :3000
npm test             # unit tests
npm run typecheck
```

To build and run the image from a checkout instead of pulling it:

```bash
cp config/config.example.yaml config/config.yaml
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

| Environment variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `CONFIG_PATH` | `/config/config.yaml` | |
| `ICONS_DIR` | `/icons` | |
| `DATA_DIR` | `/data` | the icon cache lives in `icon-cache/` here |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | `docker.host` in the config takes precedence |
| `LOG_LEVEL` | `info` | |

### CI and releases

`.github/workflows/ci.yml` runs on every push to `main` and every pull request. It typechecks, tests and builds the app, then builds the Docker image to prove it builds; nothing is published.

**To release:**
1. Go to **Actions → CI → Run workflow** on `main`.
2. Tick **release**.
3. Enter a **tag** such as `v1.2.0`, or `v1.3.0-rc.1` for a pre-release.

The run then does this:
1. **Checks the tag:** it must have the right format, must not already exist, and the run must be on `main`.
2. **Builds and pushes the image** for amd64 and arm64:
   - tags `1.2.0`, `1.2`, `1` and `latest`, plus `sha-<commit>`
   - a pre-release only gets its exact version
   - `0.x` releases skip the bare major tag
   - the image comes with a list of its contents (an SBOM) and a signed record of how it was built, which you can check with `gh attestation verify oci://ghcr.io/aeroxuk/dashboard:1.2.0 --repo AeroXuk/dashboard`
3. **Creates the git tag and a GitHub release** with generated notes.

New GHCR packages start **private**; to allow anonymous pulls, make the package public in its settings.
