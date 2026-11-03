import { test } from "node:test";
import assert from "node:assert/strict";
import { fabric, lens, project } from "../src/ui/space.ts";

const camera = { yaw: 0, pitch: .5, dist: 12, target: -1.1, focal: 800, cx: 400, cy: 300 };

test("the fabric sags deepest at the well and dents under a planet", () => {
  const flat = fabric(8, 0, 0, []);
  assert.ok(fabric(0, 0, 0, []) < fabric(2, 0, 0, []));
  assert.ok(fabric(2, 0, 0, []) < flat);
  assert.ok(fabric(8, 0, 0, [{ x: 8, z: 0, m: .3 }]) < flat - .5);
});

test("the camera looks at its target and keeps x to the right, y up", () => {
  const l = lens(camera);
  const [x, y] = project(l, 0, -1.1, 0)!;
  assert.ok(Math.abs(x - 400) < 1e-9 && Math.abs(y - 300) < 1e-9);
  assert.ok(project(l, 1, -1.1, 0)![0] > 400);
  assert.ok(project(l, 0, 0, 0)![1] < 300);
  assert.equal(project(l, 0, 6, 24), null);
});
