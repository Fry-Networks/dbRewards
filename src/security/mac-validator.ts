const MAC_ADDRESS_REGEX = /^([0-9A-F]{2})([:-])(?:[0-9A-F]{2}\2){4}[0-9A-F]{2}$/i;

export interface MacValidationResult {
  valid: boolean;
  normalized?: string;
  reason?: string;
}

const repeatedCharPattern = /^([0-9A-F])\1{11}$/;
const repeatedPairPattern = /^([0-9A-F]{2})\1{5}$/;

function isSequentialRepeatedDigits(pairs: string[]): boolean {
  if (pairs.length !== 6) {
    return false;
  }

  if (!pairs.every((pair) => pair[0] === pair[1])) {
    return false;
  }

  if (!pairs.every((pair) => /^[0-9]{2}$/.test(pair))) {
    return false;
  }

  const digits = pairs.map((pair) => Number(pair[0]));
  for (let i = 1; i < digits.length; i++) {
    if ((digits[i - 1] + 1) % 10 !== digits[i]) {
      return false;
    }
  }

  return true;
}

export function validateMacAddress(input: string | null | undefined): MacValidationResult {
  if (!input) {
    return { valid: false, reason: "missing" };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "empty" };
  }

  if (!MAC_ADDRESS_REGEX.test(trimmed)) {
    return { valid: false, reason: "format" };
  }

  const sanitized = trimmed.replace(/[:-]/g, "").toUpperCase();
  if (sanitized.length !== 12) {
    return { valid: false, reason: "length" };
  }

  if (repeatedCharPattern.test(sanitized)) {
    return { valid: false, reason: "repeated_characters" };
  }

  if (repeatedPairPattern.test(sanitized)) {
    return { valid: false, reason: "repeated_pairs" };
  }

  const pairs = sanitized.match(/.{2}/g) ?? [];
  if (isSequentialRepeatedDigits(pairs)) {
    return { valid: false, reason: "sequential_repeated_digits" };
  }

  const normalized = pairs.join(":");
  return { valid: true, normalized };
}

export { MAC_ADDRESS_REGEX };
