import { test } from "node:test";
import assert from "node:assert/strict";
import { activityForProject, canClaim, connectCommand, driveDownload, driveHeaders, MAX_DRIVE_FILE_BYTES, nodeReady, nodesForProject, nodeState, ownsLease, subhubRequest, subhubUrl, validDrivePath, type SubhubNode, type SubhubWork } from "../src/lib/subhubs.ts";
import { parseRoute } from "../src/router.ts";

const node: SubhubNode = { id: "office", space: "quirq", owner: "dev", label: "Office", mode: "backup", enabled: true, healthy: true, status: "ready", errors: [], capacityBytes: 1024, freeBytes: 512, createdAt: 1, seenAt: 2, drive: { files: 0, bytes: 0, updatedAt: null }, backups: [{ project: "quirq/app", snapshot: "abc", oid: "def", bytes: 10 }] };

test("the sub-hub tab belongs to a space without changing project routes", () => {
  assert.deepEqual(parseRoute("/quirq", "#/subhubs"), { page: "space", place: { space: "quirq", project: "" }, tab: "subhubs" });
  assert.deepEqual(parseRoute("/quirq/app", "#/activity"), { page: "project", place: { space: "quirq", project: "app" }, tab: "activity" });
});

test("sub-hub URLs encode paths and omit aggregate space without leaking node credentials", () => {
  assert.equal(subhubUrl("/nodes"), "/-/api/subhubs/nodes");
  const url = new URL(subhubUrl("/drive/file", { space: "quirq", node: "office", path: "reports/a & b.txt" }), "https://hub.example");
  assert.equal(url.searchParams.get("path"), "reports/a & b.txt");
  assert.equal(url.searchParams.get("space"), "quirq");
  assert.equal(url.searchParams.has("token"), false);
  const listing = new URL(subhubUrl("/drive/files", { space: "quirq", node: "office", prefix: "reports & notes/" }), "https://hub.example");
  assert.equal(listing.searchParams.get("prefix"), "reports & notes/");
});

test("connect command safely quotes local directories for both shells and requires reachable drive address", () => {
  assert.equal(connectCommand({ space: "quirq", id: "office", mode: "backup", storage: "D:\\Shared drive\\Sam's files" }), "spacehub subhub run --space quirq --id office --mode backup --storage 'D:\\Shared drive\\Sam''s files'");
  const command = connectCommand({ space: "quirq", id: "drive-1", mode: "drive", storage: "/data/Sam's drive", advertise: "https://node.example", shell: "sh" });
  assert.ok(command.includes("'/data/Sam'\"'\"'s drive'"));
  assert.ok(command.endsWith("--advertise https://node.example"));
  assert.throws(() => connectCommand({ space: "quirq", id: "$(run)", mode: "backup", storage: "data" }));
  assert.throws(() => connectCommand({ space: "quirq", id: "office", mode: "backup", storage: "data\ncommand" }));
  assert.throws(() => connectCommand({ space: "quirq", id: "office", mode: "drive", storage: "data" }), /HTTPS/);
  assert.throws(() => connectCommand({ space: "quirq", id: "office", mode: "drive", storage: "data", advertise: "https://user:secret@node.example" }), /credentials/);
});

test("routing and presence distinguish paused, offline and degraded nodes, and scope projects exactly", () => {
  assert.equal(nodeReady(node), true);
  assert.equal(nodeState({ ...node, enabled: false }), "Paused");
  assert.equal(nodeReady({ ...node, enabled: false }), false);
  assert.equal(nodeState({ ...node, healthy: false }), "Offline");
  assert.equal(nodeReady({ ...node, status: "degraded" }), true);
  assert.equal(nodeState({ ...node, status: "degraded" }), "Needs attention");
  assert.equal(nodesForProject([node], "quirq/app").length, 1);
  assert.equal(nodesForProject([node], "quirq/application").length, 0);
  const events = ["quirq/app", "quirq/app/file.txt", "quirq/application"].map((subject, i) => ({ id: String(i), space: "quirq", nodeId: null, at: i, kind: "backup_changed", subject, text: "" }));
  assert.deepEqual(activityForProject(events, "quirq/app").map(item => item.id), ["0", "1"]);
});

test("drive updates use create-only or an exact content hash precondition", () => {
  assert.deepEqual(driveHeaders(), { "If-None-Match": "*" });
  assert.deepEqual(driveHeaders({ sha256: "ab".repeat(32) }), { "If-Match": '"' + "ab".repeat(32) + '"' });
  assert.equal(MAX_DRIVE_FILE_BYTES, 16_777_216);
  assert.equal(validDrivePath("reports/new file.txt"), true);
  for (const path of ["", "/absolute", "../parent", "a/../b", "a//b", "a/./b", "a\\b", "a:b", "a\u0000b"]) assert.equal(validDrivePath(path), false, path);
});

test("work controls use the current identity and unexpired fenced lease", () => {
  const work = { status: "claimed", worker: "dev", fence: 3, leaseUntil: 5000 } as SubhubWork;
  assert.equal(ownsLease(work, "dev", 4000), true);
  assert.equal(ownsLease(work, "other", 4000), false);
  assert.equal(ownsLease(work, "dev", 5000), false);
  assert.equal(canClaim(work, 4999), false);
  assert.equal(canClaim(work, 5000), true);
  assert.equal(canClaim({ ...work, status: "completed" }, 6000), false);
});

test("old HTML 404s and conditional upload conflicts produce useful errors without replacing the page", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => { assert.equal(options?.credentials, "same-origin"); return new Response("<html>Not found</html>", { status: 404 }); };
    await assert.rejects(subhubRequest(subhubUrl("/nodes")), /unavailable on this hub/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "precondition failed" }), { status: 412 });
    await assert.rejects(subhubRequest(subhubUrl("/drive/file")), /file changed/);
    globalThis.fetch = async () => new Response(JSON.stringify({ nodes: [] }), { status: 200 });
    assert.deepEqual(await subhubRequest(subhubUrl("/nodes")), { nodes: [] });
    globalThis.fetch = async () => new Response("offline", { status: 503 });
    await assert.rejects(driveDownload(subhubUrl("/drive/file")), /offline or unavailable/);
    globalThis.fetch = async () => new Response("file bytes", { status: 200 });
    assert.equal(await (await driveDownload(subhubUrl("/drive/file"))).text(), "file bytes");
  } finally { globalThis.fetch = original; }
});
