/**
 * Normalises a phone number to E.164. Nigerian numbers are accepted in the
 * usual local forms ("0803 123 4567", "8031234567", "2348031234567",
 * "+234 803 123 4567"). Foreign numbers must start with "+".
 * Returns null when the input cannot be a valid number.
 */
export function normalisePhone(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const plus = raw.startsWith('+');
  const digits = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;

  if (plus) {
    if (digits.startsWith('234')) return nigerian(digits.slice(3));
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.startsWith('234') && digits.length === 13) return nigerian(digits.slice(3));
  if (digits.startsWith('0') && digits.length === 11) return nigerian(digits.slice(1));
  if (digits.length === 10) return nigerian(digits);
  return null;
}

function nigerian(national: string): string | null {
  // Mobile (7/8/9 + 9 digits) and landline national numbers are 10 digits.
  return /^[1-9]\d{9}$/.test(national) ? `+234${national}` : null;
}

/** "+234803•••4567" for logs and digest recipient lists. */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '•••';
  return `${e164.slice(0, 7)}•••${e164.slice(-4)}`;
}
