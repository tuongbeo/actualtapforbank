const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createDedupCache } = require("../src/lib/dedupCache");

describe("createDedupCache", () => {
  it("returns false (not duplicate) the first time a key is seen", () => {
    const cache = createDedupCache();
    assert.strictEqual(cache.checkAndMark("key-1"), false);
  });

  it("returns true (duplicate) when the same key is checked again within the TTL", () => {
    const cache = createDedupCache();
    cache.checkAndMark("key-1");
    assert.strictEqual(cache.checkAndMark("key-1"), true);
  });

  it("treats different keys independently", () => {
    const cache = createDedupCache();
    cache.checkAndMark("key-1");
    assert.strictEqual(cache.checkAndMark("key-2"), false);
  });

  it("returns false again once the TTL has expired", async () => {
    const cache = createDedupCache(10); // 10ms TTL for the test
    cache.checkAndMark("key-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(cache.checkAndMark("key-1"), false);
  });
});
