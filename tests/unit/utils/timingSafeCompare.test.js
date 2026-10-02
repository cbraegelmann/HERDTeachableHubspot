const timingSafeCompare = require("../../../src/utils/timingSafeCompare");

describe("timingSafeCompare", () => {
  test("returns true for identical strings", () => {
    expect(timingSafeCompare("secret-value", "secret-value")).toBe(true);
  });

  test("returns false for different strings of the same length", () => {
    expect(timingSafeCompare("secret-value", "secret-vaLue")).toBe(false);
  });

  test("returns false for different-length strings without throwing", () => {
    expect(timingSafeCompare("short", "much-longer-string")).toBe(false);
  });

  test("returns false for non-string input without throwing", () => {
    expect(timingSafeCompare(undefined, "secret-value")).toBe(false);
    expect(timingSafeCompare("secret-value", undefined)).toBe(false);
    expect(timingSafeCompare(null, null)).toBe(false);
  });
});
