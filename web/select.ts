/** Pure selection logic: which access method a tile should use, and how a method looks overall. */

export type ProbeState = 'pending' | 'up' | 'down';

export type Pick =
  | { kind: 'method'; method: string }
  | { kind: 'pending'; tentative: string | undefined }
  | { kind: 'none'; fallback: string | undefined };

export function pickMethod(
  order: string[],
  results: Record<string, ProbeState | undefined>,
  pinned?: string | null,
): Pick {
  if (pinned && order.includes(pinned) && results[pinned] === 'up') {
    return { kind: 'method', method: pinned };
  }
  for (const m of order) {
    const s = results[m] ?? 'pending';
    if (s === 'up') return { kind: 'method', method: m };
    if (s === 'pending') return { kind: 'pending', tentative: order[0] };
  }
  return { kind: 'none', fallback: order[0] };
}

export type MethodStatus = 'online' | 'offline' | 'checking' | 'unused';

export function methodStatus(states: ProbeState[]): { status: MethodStatus; up: number; total: number } {
  const total = states.length;
  const up = states.filter((s) => s === 'up').length;
  let status: MethodStatus;
  if (up > 0) status = 'online';
  else if (states.includes('pending')) status = 'checking';
  else if (total > 0) status = 'offline';
  else status = 'unused';
  return { status, up, total };
}
