// Tiny in-memory cache shared across pages, keyed by resource+id, so navigating back to (or
// into) a page paints instantly from the last-loaded value while a background refetch refreshes
// it. Lives for the app session only (cleared on full reload). Not for durable state.

const store = new Map<string, unknown>()

export const cacheKey = (kind: string, id: string) => `${kind}:${id}`
export const cacheGet = <T>(key: string): T | undefined => store.get(key) as T | undefined
// Returns the value so callers can do `setState(cacheSet(key, v))` in one line.
export const cacheSet = <T>(key: string, value: T): T => { store.set(key, value); return value }
