import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { drawBlocks, drawExercises, newSeed, seededShuffle } from "../src/attempts/random.js";

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

  test("drawBlocks: per-block picks, deterministic for a seed, no duplicates, order and shuffle flags", () => {
    const blocks = [
      { title: "A", pickCount: 2, shuffle: true, pool: ["a1", "a2", "a3", "a4"] },
      { title: "B", pickCount: null, shuffle: false, pool: ["b1", "b2", "b3"] },
      { title: "C", pickCount: 1, shuffle: false, pool: ["c1", "c2", "c3"] },
    ];
    assert.deepEqual(drawBlocks(blocks, 5), drawBlocks(blocks, 5));
    for (let seed = 1; seed <= 60; seed++) {
      const drawn = drawBlocks(blocks, seed);
      assert.deepEqual(drawn.map((d) => d.title), ["A", "B", "C"]);
      assert.equal(drawn[0]!.exerciseIds.length, 2);
      assert.ok(drawn[0]!.exerciseIds.every((id) => blocks[0]!.pool.includes(id)));
      assert.deepEqual(drawn[1]!.exerciseIds, ["b1", "b2", "b3"], "no shuffle keeps the block order");
      assert.equal(drawn[2]!.exerciseIds.length, 1);
      const all = drawn.flatMap((d) => d.exerciseIds);
      assert.equal(new Set(all).size, all.length);
    }
    // Without shuffle the drawn subset still follows the block order.
    for (let seed = 1; seed <= 40; seed++) {
      const subset = drawBlocks([{ title: "S", pickCount: 3, shuffle: false, pool: ["x1", "x2", "x3", "x4", "x5"] }], seed)[0]!.exerciseIds;
      assert.deepEqual(subset, [...subset].sort());
    }
    // Shuffle varies the order inside a block; shuffleBlocks varies the block order.
    const inner = new Set<string>();
    const outer = new Set<string>();
    for (let seed = 1; seed <= 80; seed++) {
      inner.add(drawBlocks(blocks, seed)[0]!.exerciseIds.join());
      outer.add(drawBlocks(blocks, seed, new Set(), true).map((d) => d.title).join());
    }
    assert.ok(inner.size > 3);
    assert.ok(outer.size > 3);
    assert.deepEqual(new Set(drawBlocks(blocks, 9, new Set(), true).map((d) => d.blockIndex)), new Set([0, 1, 2]));
  });

  test("drawBlocks: seen exercises are used last inside their own block", () => {
    const blocks = [
      { title: "A", pickCount: 2, shuffle: true, pool: ["a1", "a2", "a3", "a4"] },
      { title: "B", pickCount: 1, shuffle: true, pool: ["b1", "b2"] },
    ];
    const seen = new Set(["a1", "a2", "b1"]);
    for (let seed = 1; seed <= 40; seed++) {
      const drawn = drawBlocks(blocks, seed, seen);
      assert.deepEqual([...drawn[0]!.exerciseIds].sort(), ["a3", "a4"]);
      assert.deepEqual(drawn[1]!.exerciseIds, ["b2"]);
    }
  });

  test("new seeds fit a Postgres integer and vary", () => {
    const seeds = new Set(Array.from({ length: 20 }, newSeed));
    assert.ok(seeds.size > 15);
    for (const s of seeds) assert.ok(Number.isInteger(s) && s > 0 && s < 2 ** 31);
  });
});
