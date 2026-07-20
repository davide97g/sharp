// Dependency-free fractional indexing over base-62 keys. A key is a string of
// digits [0-9A-Za-z] (ordered by char code, so lexicographic string order ==
// numeric order of the fraction 0.d1d2d3...). `between(a, b)` returns a key that
// sorts strictly between a and b (null = open end); adjacent keys are handled by
// extending length. Keys generated here never start with '0', so the low-end
// midpoint always leaves room to insert before the first item.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

const val = (c: string): number => DIGITS.indexOf(c)

export function between(a: string | null, b: string | null): string {
  const lo = a ?? ''
  let hi = b
  let out = ''
  let i = 0
  while (true) {
    const x = i < lo.length ? val(lo[i]) : 0
    const y = hi != null && i < hi.length ? val(hi[i]) : BASE
    if (y - x > 1) {
      // room to fit a digit strictly between the two bounds
      return out + DIGITS[x + Math.floor((y - x) / 2)]
    }
    // gap too small: commit the low digit and descend one place
    out += DIGITS[x]
    if (y === x + 1) hi = null // upper bound satisfied; extend freely above lo
    i++
  }
}

// Convenience: append a key after `last` (or the first key when `last` is null).
export function appendIndex(last: string | null): string {
  return between(last, null)
}
