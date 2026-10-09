// The keypad's value is a string such as "", "7", "23.", "23.5" or "23.50".
// Money never touches a float: the string goes straight to integer USDC base units.

export type Key = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back';
export type Rejection = 'max' | 'decimals' | 'dot' | 'empty';

export interface Pressed {
  value: string;
  /** Set when the key was refused and the value is unchanged. */
  rejected?: Rejection;
}

export function press(value: string, key: Key, maxUnits: bigint): Pressed {
  if (key === 'back') {
    return value ? { value: value.slice(0, -1) } : { value, rejected: 'empty' };
  }
  if (key === '.') {
    if (value.includes('.')) return { value, rejected: 'dot' };
    return { value: `${value || '0'}.` };
  }
  const dot = value.indexOf('.');
  if (dot >= 0 && value.length - dot > 2) return { value, rejected: 'decimals' };
  const next = value === '0' ? key : value + key;
  if (toUnits(next) > maxUnits) return { value, rejected: 'max' };
  return { value: next };
}

/** Keypad string to USDC base units (6 decimals). */
export function toUnits(value: string): bigint {
  if (!/^\d*\.?\d{0,2}$/.test(value)) throw new Error(`not an amount: ${value}`);
  const [whole = '', cents = ''] = value.split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt(cents.padEnd(2, '0')) * 10_000n;
}

/**
 * Integer base units to a decimal string, truncated (never rounded up).
 * Keeps at least `min` and at most `max` decimal places.
 */
export function formatUnits(units: bigint, decimals: number, min: number, max = min): string {
  const text = units.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, -decimals);
  let fraction = text.slice(-decimals).slice(0, max);
  while (fraction.length > min && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return fraction ? `${whole}.${fraction}` : whole;
}

export const formatUsdc = (units: bigint): string => formatUnits(units, 6, 2, 6);
export const formatSol = (lamports: bigint, places = 4): string => formatUnits(lamports, 9, places);
