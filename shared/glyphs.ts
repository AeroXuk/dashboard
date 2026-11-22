/**
 * Built-in icons for methods and groups, drawn inline as 24x24 stroke SVGs (no download needed).
 * Use them in config as `icon: home`, `icon: vpn`, `icon: film`, etc.
 */
export const GLYPHS = {
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  lan: ['M9 3h6v5H9z', 'M12 8v4', 'M5 12h14', 'M5 12v4', 'M19 12v4', 'M2 16h6v5H2z', 'M16 16h6v5h-6z'],
  wifi: ['M2 9a15 15 0 0 1 20 0', 'M5 12.5a10 10 0 0 1 14 0', 'M8.5 16a5 5 0 0 1 7 0', 'M12 20h.01'],
  vpn: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M3 12h18', 'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  server: ['M3 4h18v7H3z', 'M3 13h18v7H3z', 'M7 7.5h.01', 'M7 16.5h.01'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  // Mostly for groups
  film: ['M3 4h18v16H3z', 'M7 4v16', 'M17 4v16', 'M3 8h4', 'M3 12h4', 'M3 16h4', 'M17 8h4', 'M17 12h4', 'M17 16h4'],
  tv: ['M3 7h18v12H3z', 'M8 3l4 4 4-4'],
  music: ['M9 18V5l12-2v13', 'M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
  cog: [
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3',
    'M4.9 4.9l2.1 2.1', 'M17 17l2.1 2.1', 'M4.9 19.1l2.1-2.1', 'M17 7l2.1-2.1',
  ],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M2 20h20'],
  camera: ['M3 7h4l2-3h6l2 3h4v13H3z', 'M12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7'],
  database: [
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z',
    'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
    'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'],
  tools: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z'],
  cpu: ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M9 2v3', 'M15 2v3', 'M9 19v3', 'M15 19v3', 'M2 9h3', 'M2 15h3', 'M19 9h3', 'M19 15h3'],
} as const satisfies Record<string, readonly string[]>;

export type GlyphName = keyof typeof GLYPHS;

export function isGlyph(name: string): name is GlyphName {
  return Object.prototype.hasOwnProperty.call(GLYPHS, name);
}

/** Pick a sensible built-in icon from a method's id and label when none is configured. */
export function guessGlyph(id: string, label: string): GlyphName {
  const s = `${id} ${label}`.toLowerCase();
  if (/\b(lan|local|home|internal|direct)\b/.test(s)) return 'home';
  if (/(tail|vpn|wireguard|wg|zerotier|netbird|headscale)/.test(s)) return 'vpn';
  if (/(public|internet|wan|cloudflare|tunnel|external|www)/.test(s)) return 'globe';
  if (/(wifi|wlan)/.test(s)) return 'wifi';
  return 'link';
}
