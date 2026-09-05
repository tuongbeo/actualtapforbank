const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

const createDedupCache = (ttlMs = DEFAULT_TTL_MS) => {
  const expiryByKey = new Map();

  return {
    checkAndMark(key) {
      const now = Date.now();
      const expiresAt = expiryByKey.get(key);

      if (expiresAt !== undefined && expiresAt > now) {
        return true;
      }

      expiryByKey.set(key, now + ttlMs);
      return false;
    },
  };
};

module.exports = { createDedupCache, DEFAULT_TTL_MS };
