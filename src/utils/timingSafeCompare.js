const crypto = require("crypto");

/**
 * Constant-time string comparison. Returns false (rather than throwing) on
 * length mismatch or non-string input instead of leaking timing information
 * or crashing the caller.
 */
const timingSafeCompare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

module.exports = timingSafeCompare;
