/**
 * Shared environment-variable truthy-check helper.
 * Returns true iff the value (after trimming and lowercasing) is one of:
 * '1', 'true', 'yes', 'on'.
 * Accepts undefined so callers can pass process.env['KEY'] directly.
 */
export function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
