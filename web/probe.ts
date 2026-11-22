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
    });
    return true;
  } catch {
    return false;
  }
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
