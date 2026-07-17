// File tiles reuse the canvas' opaque-string sid slot, same pattern as
// terminal tiles (`term:<uuid>`). The sid encodes the file's project-
// relative path so the tile can render the right file without extra
// state: `file:<encoded path>`.
//
// The Workspace's tile switch routes file: sids to <FileTile>; everything
// else (drag, resize, focus, remove) works exactly like a session tile.

const FILE_PREFIX = 'file:';

export function isFileSid(sid: string): boolean {
  return sid.startsWith(FILE_PREFIX);
}

export function newFileSid(path: string): string {
  // Encode the path so any character (colon, space, unicode) is safe as an
  // opaque tile id — the tile is keyed by sid, and we want no ambiguity
  // when the same path is opened twice.
  return FILE_PREFIX + encodeURIComponent(path);
}

export function filePath(sid: string): string {
  if (!isFileSid(sid)) return '';
  return decodeURIComponent(sid.slice(FILE_PREFIX.length));
}
