/**
 * Component: Audiobookshelf Path Mapper
 * Documentation: documentation/features/chapter-merging.md
 *
 * Audiobookshelf reports item paths from its own container mount (e.g. /audiobooks/A/B),
 * which usually differ from ReadMeABook's (e.g. /Audiobooks/Audio/A/B). Translate an ABS
 * item path to a local one, trying in order:
 * 1. the path as-is (same mounts)
 * 2. media_dir + item.relPath (media_dir is the ABS library folder)
 * 3. prefix mappings learned from books whose ABS path and local path are both known
 * Only a path that exists locally (inside media_dir) is returned.
 */

import path from 'path';

export interface PrefixMapping {
  from: string; // ABS-side prefix
  to: string;   // local prefix
}

const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Learn ABS→local prefix pairs from known path pairs: strip their longest common
 * trailing segments; what's left is the mount prefix on each side. Most common first.
 */
export function learnPrefixMappings(pairs: Array<{ absPath: string; localPath: string }>): PrefixMapping[] {
  const counts = new Map<string, { mapping: PrefixMapping; count: number }>();
  for (const { absPath, localPath } of pairs) {
    const abs = toPosix(absPath).split('/');
    const local = toPosix(localPath).split('/');
    let shared = 0;
    while (shared < abs.length - 1 && shared < local.length - 1 && abs[abs.length - 1 - shared] === local[local.length - 1 - shared]) {
      shared++;
    }
    if (shared === 0) continue;
    const mapping = { from: abs.slice(0, abs.length - shared).join('/') || '/', to: local.slice(0, local.length - shared).join('/') || '/' };
    if (mapping.from === mapping.to) continue;
    const key = `${mapping.from}\u0000${mapping.to}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { mapping, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map(e => e.mapping);
}

/**
 * Mount mappings from items whose ABS path and local folder are both known: both must end
 * with the item's relPath (path inside the ABS library folder); what's before it on each
 * side is the mount. Pairs where the local folder is a different copy of the book (e.g.
 * another author-name folder) don't end with the relPath and are ignored.
 */
export function mountMappingsFromRelPaths(pairs: Array<{ absPath: string; relPath?: string; localPath: string }>): PrefixMapping[] {
  const counts = new Map<string, { mapping: PrefixMapping; count: number }>();
  for (const pair of pairs) {
    if (!pair.relPath) continue;
    const rel = `/${toPosix(pair.relPath).replace(/^\/+/, '')}`;
    const abs = toPosix(pair.absPath);
    const local = toPosix(pair.localPath);
    if (!abs.endsWith(rel) || !local.endsWith(rel)) continue;
    const mapping = { from: abs.slice(0, -rel.length) || '/', to: local.slice(0, -rel.length) || '/' };
    if (mapping.from === mapping.to) continue;
    const key = `${mapping.from}|${mapping.to}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { mapping, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map(e => e.mapping);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.posix.relative(toPosix(parent), toPosix(child));
  return !!relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative);
}

/** Local path candidates for an ABS item, in priority order (not yet checked for existence). */
export function localPathCandidates(
  item: { path: string; relPath?: string },
  mediaDir: string,
  mappings: PrefixMapping[]
): string[] {
  const absPath = toPosix(item.path || '');
  const candidates = [absPath];
  if (item.relPath) candidates.push(path.posix.join(toPosix(mediaDir), toPosix(item.relPath)));
  for (const { from, to } of mappings) {
    if (absPath === from || absPath.startsWith(`${from}/`)) candidates.push(to + absPath.slice(from.length));
  }
  return [...new Set(candidates.filter(Boolean))].filter(p => isInside(p, mediaDir));
}

/** First candidate that exists locally, or null. */
export async function resolveLocalPath(
  item: { path: string; relPath?: string },
  mediaDir: string,
  mappings: PrefixMapping[],
  exists: (p: string) => Promise<boolean>
): Promise<string | null> {
  for (const candidate of localPathCandidates(item, mediaDir, mappings)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}
