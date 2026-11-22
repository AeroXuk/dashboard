/**
 * Browser-side reachability probe. A `no-cors` fetch resolves with an opaque
 * response when the host answers at all, and rejects on network errors,
 * blocked mixed content, TLS failures or timeouts.
 */
export async function probe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      ...localNetworkInit(url, location.protocol),
    } as RequestInit);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extra fetch options that let an https page check an http:// URL on the
 * local network. Chrome's Local Network Access exempts a request from mixed
 * content blocking when it sets `targetAddressSpace: 'local'`, after the user
 * allows the browser's local network prompt. The request then fails if the
 * host turns out to be public, but an http:// request from an https page is
 * blocked anyway, so nothing that worked before can break. Other browsers
 * ignore the option. Loopback hosts are left alone: browsers already allow
 * them, and they are not in the 'local' address space.
 */
export function localNetworkInit(url: string, pageProtocol: string): { targetAddressSpace?: 'local' } {
  if (pageProtocol !== 'https:') return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (parsed.protocol !== 'http:' || isLoopback(parsed.hostname)) return {};
  return { targetAddressSpace: 'local' };
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '[::1]'
  );
}

/**
 * One round of probes. Identical URLs are probed once per round, and results
 * from a round that has since been superseded are dropped.
 */
export class ProbeRound {
  private static current = 0;
  readonly id: number;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private outstanding = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly probeFn: (url: string, timeoutMs: number) => Promise<boolean> = probe,
  ) {
    this.id = ++ProbeRound.current;
  }

  get active(): boolean {
    return this.id === ProbeRound.current;
  }

  get pending(): number {
    return this.outstanding;
  }

  /** Probe a URL; `onResult` only fires if this round is still the latest. */
  check(url: string, onResult: (up: boolean) => void): Promise<void> {
    let p = this.inflight.get(url);
    if (!p) {
      p = this.probeFn(url, this.timeoutMs);
      this.inflight.set(url, p);
    }
    this.outstanding++;
    return p.then((up) => {
      this.outstanding--;
      if (this.active) onResult(up);
    });
  }

  /** Mark this round superseded without starting a new one. */
  static invalidate(): void {
    ProbeRound.current++;
  }
}
