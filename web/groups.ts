/** Group collapse state compared with the config's defaults. */

export interface GroupDefault {
  name: string;
  /** The config's `collapsed` setting. */
  collapsed: boolean;
}

/** True when any group is collapsed or expanded differently from its config default. */
export function changedFromDefault(groups: readonly GroupDefault[], current: Readonly<Record<string, boolean>>): boolean {
  return groups.some((g) => (current[g.name] ?? g.collapsed) !== g.collapsed);
}
