import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_RECOVERY_API, instanceBackupCommand, instanceErrorMessage, instancePost, instanceRestoreBody, instanceRestoreCommand, instanceSnapshotsCommand, instanceVerifyCommand } from "../src/lib/instance-recovery.ts";
import { parseRoute } from "../src/router.ts";

const id = "ab".repeat(16);

test("global Settings includes legacy instance recovery routes while retaining space pages", () => {
  assert.deepEqual(parseRoute("/", "#/settings"), { page: "home", tab: "settings" });
  assert.deepEqual(parseRoute("/", "#/subhubs"), { page: "home", tab: "settings" });
  assert.deepEqual(parseRoute("/quirq", "#/subhubs"), { page: "home", tab: "settings" });
  assert.deepEqual(parseRoute("/quirq", "#/projects"), { page: "space", place: { space: "quirq", project: "" }, tab: "projects" });
  assert.deepEqual(parseRoute("/", ""), { page: "home" });
});

test("full-instance capture commands map directly to Docker container capture with explicit stop permission", () => {
  const command = instanceBackupCommand({ containers: ["spacehub", "spacehub-proxy"], storage: "/srv/full vault", shell: "sh" });
  assert.equal(command, "spacehub subhub backup --container spacehub --container spacehub-proxy --storage '/srv/full vault' --allow-stop");
  for (const unrelated of ["--space", "--mode", "--project", "--agent"]) assert.equal(command.includes(unrelated), false);
  assert.throws(() => instanceBackupCommand({ containers: [], storage: "/vault" }), /container/);
  assert.throws(() => instanceBackupCommand({ containers: ["hub;stop"], storage: "/vault" }), /container/);
  assert.throws(() => instanceBackupCommand({ containers: ["hub"], storage: "/vault\ncommand" }), /line breaks/);
});

test("list, verify and restore CLI commands use the full-instance vault and safe path quoting", () => {
  assert.equal(instanceSnapshotsCommand("D:\\Hub vault"), "spacehub subhub snapshots --storage 'D:\\Hub vault'");
  assert.equal(instanceVerifyCommand(id, "/vault"), `spacehub subhub verify ${id} --storage /vault`);
  assert.equal(instanceRestoreCommand(id, "/restore/Sam's hub", "/vault", "sh"), `spacehub subhub restore ${id} '/restore/Sam'"'"'s hub' --storage /vault`);
  assert.throws(() => instanceVerifyCommand("project/snapshot", "/vault"), /full-instance backup/);
});

test("restore submits only the selected instance ID and required new directory", () => {
  assert.deepEqual(instanceRestoreBody(id, " /restore/new-hub "), { id, directory: "/restore/new-hub" });
  assert.throws(() => instanceRestoreBody(id, "  "), /new restore directory/);
  assert.throws(() => instanceRestoreBody(id, "new\ndirectory"), /new restore directory/);
  assert.throws(() => instanceRestoreBody("not-a-snapshot", "/restore/new-hub"), /full-instance backup/);
});

test("recovery permission errors refer to the full server operator", () => {
  assert.match(instanceErrorMessage(403), /operator of this Spacehub server/);
  assert.doesNotMatch(instanceErrorMessage(403), /org|space owner/i);
  assert.match(instanceErrorMessage(404), /Full-instance recovery/);
  assert.match(instanceErrorMessage(409), /new directory/);
});

test("verify and restore POSTs use only the global recovery API and same-origin session", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; method: string; body: unknown }[] = [];
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(options?.credentials, "same-origin");
      requests.push({ url: String(url), method: options?.method ?? "GET", body: JSON.parse(String(options?.body)) });
      return new Response(JSON.stringify({ files: 2, bytes: 100 }), { status: 200 });
    };
    await instancePost(`/snapshots/${id}/verify`);
    await instancePost("/restore", instanceRestoreBody(id, "/restore/new-hub"));
    assert.deepEqual(requests, [{ url: `${INSTANCE_RECOVERY_API}/snapshots/${id}/verify`, method: "POST", body: {} }, { url: `${INSTANCE_RECOVERY_API}/restore`, method: "POST", body: { id, directory: "/restore/new-hub" } }]);
    globalThis.fetch = async () => new Response("<html>Not found</html>", { status: 404 });
    await assert.rejects(instancePost("/restore", instanceRestoreBody(id, "/new")), /Full-instance recovery is not available/);
  } finally { globalThis.fetch = original; }
});
