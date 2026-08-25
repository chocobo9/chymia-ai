const STORAGE_KEY = 'choco:lockByThread';

export function readScopeLock(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeScopeLock(locks: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(locks));
  } catch {
    // quota exceeded or private mode — silently ignore
  }
}

export function clearScopeLock(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
