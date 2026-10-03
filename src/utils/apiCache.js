/**
 * In-Memory Micro-Cache for Facebook Ads Dashboard.
 * Default TTL: 30 seconds.
 */
class MicroCache {
  constructor(defaultTtlMs = 30000) {
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data, ttlMs = this.defaultTtlMs) {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs
    });
  }

  clear() {
    this.cache.clear();
  }

  delete(key) {
    this.cache.delete(key);
  }

  invalidatePrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}

const apiCache = new MicroCache(30000);

function clearApiCache() {
  apiCache.clear();
}

module.exports = {
  MicroCache,
  apiCache,
  clearApiCache
};
