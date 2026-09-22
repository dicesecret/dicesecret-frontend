// Browser-local exact-uniform d6 entropy collection.
// Ported from the established RollEntropy EntropyPool semantics.

const LOG2_6 = Math.log2(6);

function asTargetBits(value) {
  const bits = Number(value);
  if (!Number.isInteger(bits) || bits < 8 || bits % 8 !== 0) {
    throw new Error('target bits must be a positive whole-byte size');
  }
  return bits;
}

function validateD6Values(values) {
  const out = Array.from(values || [], Number);
  if (!out.length) throw new Error('accepted roll contains no dice');
  for (const value of out) {
    if (!Number.isInteger(value) || value < 1 || value > 6) {
      throw new Error(`d6 result must be from 1 through 6; got ${value}`);
    }
  }
  return out;
}

function log2BigInt(value) {
  if (value <= 0n) return -Infinity;
  // DiceSecret currently targets 128/256-bit secrets, so Number() is finite
  // throughout the intended collection range. Keep a generic fallback anyway.
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.log2(numeric);
  const bits = value.toString(2);
  const keep = Math.min(53, bits.length);
  const head = Number.parseInt(bits.slice(0, keep), 2);
  return (bits.length - keep) + Math.log2(head);
}

function outputHex(value, bits) {
  return value.toString(16).padStart(bits / 4, '0');
}

export class LocalExactEntropyCollection {
  constructor(targetBits, mode = 'exact') {
    this.targetBits = asTargetBits(targetBits);
    if (mode !== 'exact') {
      throw new Error(
        'Browser-local hash mode is not cut over yet. Use Exact uniform in this build; ' +
        'the established hash protocol is SHAKE256 and will not be silently substituted.'
      );
    }
    this.mode = mode;
    this.value = 0n;
    this.range = 1n;
    this.acceptedRolls = 0;
    this.outputValue = null;
    this.batches = [];
  }

  get complete() {
    return this.outputValue !== null;
  }

  addRoll(value) {
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1 || result > 6) {
      throw new Error(`d6 result must be from 1 through 6; got ${value}`);
    }
    this.value = this.value * 6n + BigInt(result - 1);
    this.range *= 6n;
    this.acceptedRolls += 1;
    if (this.value < 0n || this.value >= this.range) {
      throw new Error('entropy-pool invariant failed');
    }
  }

  tryExtract() {
    if (this.complete) return true;
    const modulus = 1n << BigInt(this.targetBits);
    if (this.range < modulus) return false;
    const acceptedStates = (this.range / modulus) * modulus;
    if (this.value < acceptedStates) {
      this.outputValue = this.value % modulus;
      return true;
    }
    this.value -= acceptedStates;
    this.range -= acceptedStates;
    if (this.value < 0n || this.value >= this.range) {
      throw new Error('recycled entropy-pool invariant failed');
    }
    return false;
  }

  appendBatch({ values, ordering, report }) {
    if (this.complete) throw new Error('entropy collection is already complete');
    const accepted = validateD6Values(values);
    const round = this.batches.length + 1;
    for (const value of accepted) this.addRoll(value);
    const cleanReport = structuredClone(report || {});
    delete cleanReport._manual_review_source_ordering;
    this.batches.push({
      round,
      sides: 6,
      values: accepted.slice(),
      ordering: structuredClone(ordering || {}),
      report: cleanReport,
    });
    this.tryExtract();
  }

  progress() {
    const entropy = log2BigInt(this.range);
    const remainingBits = Math.max(0, this.targetBits - entropy);
    return {
      format: 'dicevision-entropy-progress-v1',
      mode: this.mode,
      target_bits: this.targetBits,
      accepted_rolls: this.acceptedRolls,
      pool_entropy_bits: entropy,
      estimated_more_dice: this.complete ? 0 : Math.max(0, Math.ceil(remainingBits / LOG2_6)),
      complete: this.complete,
      output_hex: this.complete ? outputHex(this.outputValue, this.targetBits) : null,
    };
  }
}
