// test/admin-base-path.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { deriveBasePath } = require("../src/lib/adminBasePath");

describe("deriveBasePath", () => {
  it("returns '' for a root-domain APP_BASE_URL (no path component)", () => {
    assert.strictEqual(deriveBasePath("https://actualtap.example.com"), "");
    // A bare "/" pathname is the same case: no prefix to add.
    assert.strictEqual(deriveBasePath("https://actualtap.example.com/"), "");
  });

  it("returns the path component for a prefixed APP_BASE_URL with no trailing slash", () => {
    assert.strictEqual(deriveBasePath("https://cash.lens.io.vn/actual-transfer-hub"), "/actual-transfer-hub");
  });

  it("strips the trailing slash from a prefixed APP_BASE_URL", () => {
    assert.strictEqual(deriveBasePath("https://cash.lens.io.vn/actual-transfer-hub/"), "/actual-transfer-hub");
  });

  it("composes into a prefixed session-cookie path and admin URLs", () => {
    const basePath = deriveBasePath("https://cash.lens.io.vn/actual-transfer-hub/");
    assert.strictEqual(`${basePath}/admin`, "/actual-transfer-hub/admin");
    assert.strictEqual(`${basePath}/admin/login`, "/actual-transfer-hub/admin/login");
  });
});
