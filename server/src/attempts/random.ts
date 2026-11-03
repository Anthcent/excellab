import { randomInt } from "node:crypto";

/** Small deterministic PRNG: the same seed always produces the same sequence. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by a seeded PRNG. Returns a new array. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  return shuffleWith(items, rand);
}

function shuffleWith<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A fresh random seed for each attempt (fits a Postgres integer). */
export const newSeed = () => randomInt(1, 2_147_483_647);

/**
 * Picks and orders the exercises of one attempt.
 * - pickCount null or >= pool size: every exercise, in random order.
 * - Otherwise: prefer exercises the student has not seen in earlier attempts, fill with seen ones,
 *   then shuffle the chosen set so the order is random too.
 */
export function drawExercises(pool: readonly string[], pickCount: number | null, seed: number, seen: ReadonlySet<string> = new Set()): string[] {
  const rand = mulberry32(seed);
  if (pickCount === null || pickCount >= pool.length) return shuffleWith(pool, rand);
  const fresh = shuffleWith(pool.filter((id) => !seen.has(id)), rand);
  const old = shuffleWith(pool.filter((id) => seen.has(id)), rand);
  return shuffleWith([...fresh, ...old].slice(0, pickCount), rand);
}
