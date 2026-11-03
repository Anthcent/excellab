import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { drawExercises, newSeed, seededShuffle } from "../src/attempts/random.js";

const pool = ["a", "b", "c", "d", "e", "f"];

describe("seeded randomness", () => {
  test("the same seed always gives the same shuffle", () => {
    assert.deepEqual(seededShuffle(pool, 42), seededShuffle(pool, 42));
    assert.deepEqual(drawExercises(pool, 3, 7), drawExercises(pool, 3, 7));
  });

  test("a shuffle is a permutation and does not mutate its input", () => {
    const copy = [...pool];
    const out = seededShuffle(pool, 1);
    assert.deepEqual(pool, copy);
    assert.deepEqual([...out].sort(), copy);
  });

  test("different seeds give different draws (attempt 2 differs from attempt 1)", () => {
    const draws = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) draws.add(drawExercises(pool, 3, seed).join(","));
    assert.ok(draws.size > 20, `expected plenty of distinct draws, got ${draws.size}`);
    const orders = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) orders.add(drawExercises(pool, null, seed).join(","));
    assert.ok(orders.size > 20);
  });

  test("pickCount limits the draw, without duplicates and inside the pool", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const out = drawExercises(pool, 4, seed);
      assert.equal(out.length, 4);
      assert.equal(new Set(out).size, 4);
      assert.ok(out.every((id) => pool.includes(id)));
    }
    assert.equal(drawExercises(pool, 99, 1).length, pool.length);
    assert.equal(drawExercises(pool, null, 1).length, pool.length);
  });

  test("unseen exercises are preferred when the pool is bigger than the pick", () => {
    const seen = new Set(["a", "b", "c"]);
    for (let seed = 1; seed <= 50; seed++) {
      const out = drawExercises(pool, 3, seed, seen);
      assert.deepEqual([...out].sort(), ["d", "e", "f"]);
    }
    const mixed = drawExercises(pool, 5, 3, seen);
    assert.ok(["d", "e", "f"].every((id) => mixed.includes(id)));
  });

  test("new seeds fit a Postgres integer and vary", () => {
    const seeds = new Set(Array.from({ length: 20 }, newSeed));
    assert.ok(seeds.size > 15);
    for (const s of seeds) assert.ok(Number.isInteger(s) && s > 0 && s < 2 ** 31);
  });
});
