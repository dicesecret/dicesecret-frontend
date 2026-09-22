(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RollEntropySecret = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("expected byte data");
  }

  function validateTargetBits(targetBits) {
    const bits = Number(targetBits);
    if (!Number.isSafeInteger(bits) || bits < 8 || bits % 8 !== 0) {
      throw new Error("target bits must be a positive whole-byte size");
    }
    return bits;
  }

  function randomBytesForBits(targetBits, cryptoImpl = root.crypto) {
    const bits = validateTargetBits(targetBits);
    if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== "function") {
      throw new Error("crypto.getRandomValues() is unavailable in this browser");
    }
    const output = new Uint8Array(bits / 8);
    cryptoImpl.getRandomValues(output);
    return output;
  }

  function xorBytes(left, right) {
    const a = asBytes(left);
    const b = asBytes(right);
    if (a.length !== b.length) throw new Error("cannot XOR byte arrays of different lengths");
    const output = new Uint8Array(a.length);
    for (let index = 0; index < a.length; index += 1) output[index] = a[index] ^ b[index];
    return output;
  }

  function equalBytes(left, right) {
    const a = asBytes(left);
    const b = asBytes(right);
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
    return difference === 0;
  }

  function createSecretSession(options = {}) {
    const targetBits = validateTargetBits(options.targetBits);
    const privateMix = options.privateMix !== false;
    let browserRandom = privateMix ? randomBytesForBits(targetBits, options.cryptoImpl || root.crypto) : null;
    let finalBytes = null;
    let verification = null;
    let destroyed = false;

    function assertLive() {
      if (destroyed) throw new Error("browser secret session has been destroyed");
    }

    function finalize(diceDerivedBytes) {
      assertLive();
      const dice = asBytes(diceDerivedBytes);
      if (dice.length * 8 !== targetBits) {
        throw new Error(`dice-derived buffer contains ${dice.length * 8} bits, not ${targetBits}`);
      }
      if (finalBytes === null) {
        finalBytes = privateMix ? xorBytes(dice, browserRandom) : new Uint8Array(dice);
        if (privateMix) {
          const recombined = xorBytes(dice, browserRandom);
          verification = equalBytes(recombined, finalBytes);
          recombined.fill(0);
        } else {
          verification = equalBytes(dice, finalBytes);
        }
        if (browserRandom !== null) {
          browserRandom.fill(0);
          browserRandom = null;
        }
      }
      return new Uint8Array(finalBytes);
    }

    function audit() {
      assertLive();
      return Object.freeze({
        finalized: finalBytes !== null,
        verified: verification,
        privateMix,
        mode: privateMix ? "private-browser-mix" : "dice-only",
      });
    }

    function destroy() {
      if (browserRandom !== null) browserRandom.fill(0);
      if (finalBytes !== null) finalBytes.fill(0);
      browserRandom = null;
      finalBytes = null;
      destroyed = true;
    }

    return Object.freeze({
      targetBits,
      privateMix,
      mode: privateMix ? "private-browser-mix" : "dice-only",
      finalize,
      audit,
      destroy,
    });
  }

  return Object.freeze({
    validateTargetBits,
    randomBytesForBits,
    xorBytes,
    equalBytes,
    createSecretSession,
  });
});
