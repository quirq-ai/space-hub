import { test } from "node:test";
import assert from "node:assert/strict";
import { foldedSegments } from "../src/lib/path-fold.ts";

// space, project, three folders, the file.
const path = [60, 120, 50, 70, 60, 100];
const total = path.reduce((sum, width) => sum + width, 0);

test("the whole path shows when it fits", () => {
  assert.deepEqual(foldedSegments(path, total, 30), []);
  assert.deepEqual(foldedSegments(path, total + 100, 30), []);
});

test("folders fold first, nearest the top first, and the menu's own width counts", () => {
  assert.deepEqual(foldedSegments(path, total - 1, 30), [2]);
  assert.deepEqual(foldedSegments(path, total - 30, 30), [2, 3]);
  assert.deepEqual(foldedSegments(path, 60 + 120 + 30 + 100, 30), [2, 3, 4]);
});

test("then the project, then the space; where you are always stays", () => {
  assert.deepEqual(foldedSegments(path, 60 + 30 + 100, 30), [1, 2, 3, 4]);
  assert.deepEqual(foldedSegments(path, 30 + 100, 30), [0, 1, 2, 3, 4]);
  assert.deepEqual(foldedSegments(path, 10, 30), [0, 1, 2, 3, 4]);
});

test("room left over goes back to the folders nearest where you are", () => {
  // The project had to go, which leaves room for the last folder but not two.
  assert.deepEqual(foldedSegments(path, 60 + 30 + 60 + 100, 30), [1, 2, 3]);
  // With room for the project, it stays instead.
  assert.deepEqual(foldedSegments(path, 60 + 120 + 30 + 100, 30), [2, 3, 4]);
});

test("short paths never fold the place you are in", () => {
  assert.deepEqual(foldedSegments([500], 100, 30), []);
  assert.deepEqual(foldedSegments([200, 300], 100, 30), [0]);
  assert.deepEqual(foldedSegments([100, 200, 300], 430, 30), [1]);
});
