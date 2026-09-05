const { describe, it } = require("node:test");
const assert = require("node:assert");
const { identify, AmbiguousMatchError } = require("../src/templates/matcher");

const template = (name, contains) => ({ name, match: { contains } });

describe("identify", () => {
  it("returns the template whose match.contains are all present (case-insensitive)", () => {
    const templates = [template("a", ["FOO", "bar"]), template("b", ["baz"])];
    const result = identify("something foo and BAR here", templates);
    assert.strictEqual(result.name, "a");
  });

  it("returns null when no template matches", () => {
    const templates = [template("a", ["FOO"])];
    assert.strictEqual(identify("nothing relevant", templates), null);
  });

  it("returns null when only some of a template's contains are present", () => {
    const templates = [template("a", ["FOO", "MISSING"])];
    assert.strictEqual(identify("foo is here", templates), null);
  });

  it("throws AmbiguousMatchError when more than one template matches", () => {
    const templates = [template("a", ["FOO"]), template("b", ["FOO"])];
    assert.throws(() => identify("foo appears here", templates), AmbiguousMatchError);
    assert.throws(() => identify("foo appears here", templates), /a, b/);
  });
});
