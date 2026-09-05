const { describe, it } = require("node:test");
const assert = require("node:assert");
const { buildDateRegex, toISODate } = require("../src/templates/dateFormat");

describe("buildDateRegex", () => {
  it("builds named groups for each recognized token and keeps other characters literal", () => {
    const regex = buildDateRegex("DD/MM/YYYY HH:mm:ss");
    const match = regex.exec("04/09/2026 08:41:29");
    assert.ok(match);
    assert.strictEqual(match.groups.day, "04");
    assert.strictEqual(match.groups.month, "09");
    assert.strictEqual(match.groups.year, "2026");
    assert.strictEqual(match.groups.hour, "08");
    assert.strictEqual(match.groups.minute, "41");
    assert.strictEqual(match.groups.second, "29");
  });

  it("supports a date-only format with no time tokens", () => {
    const regex = buildDateRegex("YYYY-MM-DD");
    const match = regex.exec("2026-09-04");
    assert.ok(match);
    assert.strictEqual(match.groups.year, "2026");
    assert.strictEqual(match.groups.month, "09");
    assert.strictEqual(match.groups.day, "04");
  });
});

describe("toISODate", () => {
  it("reassembles YYYY-MM-DD from a matched raw value", () => {
    assert.strictEqual(toISODate("04/09/2026 08:41:29", "DD/MM/YYYY HH:mm:ss"), "2026-09-04");
  });

  it("throws when the raw value doesn't match the format", () => {
    assert.throws(
      () => toISODate("not a date", "DD/MM/YYYY HH:mm:ss"),
      /Could not parse date/
    );
  });
});
