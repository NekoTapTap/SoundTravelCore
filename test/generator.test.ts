import assert from "node:assert/strict";
import test from "node:test";
import { TrainAmbienceGenerator } from "../src/generator.js";
import { defaultConfig } from "../src/model.js";

test("same seed is deterministic across arbitrary block boundaries", () => {
  const first = new TrainAmbienceGenerator(defaultConfig);
  const second = new TrainAmbienceGenerator(defaultConfig);
  const whole = first.render(4096);
  const partA = second.render(997);
  const partB = second.render(4096 - 997);
  assert.deepEqual(Array.from(whole.left), [...partA.left, ...partB.left]);
  assert.deepEqual(Array.from(whole.right), [...partA.right, ...partB.right]);
});

test("output is finite, stereo, non-silent, and bounded", () => {
  const generator = new TrainAmbienceGenerator(defaultConfig);
  const block = generator.render(defaultConfig.sampleRate * 2);
  let energy = 0;
  let sideEnergy = 0;
  for (let i = 0; i < block.left.length; i += 1) {
    const left = block.left[i] ?? Number.NaN;
    const right = block.right[i] ?? Number.NaN;
    assert.ok(Number.isFinite(left) && Number.isFinite(right));
    assert.ok(Math.abs(left) <= 1 && Math.abs(right) <= 1);
    energy += left * left + right * right;
    sideEnergy += (left - right) ** 2;
  }
  assert.ok(energy > 1e-4);
  assert.ok(sideEnergy > 1e-6);
});
