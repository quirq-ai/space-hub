import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DENIED_HEADER, endsSession, leave, leavingReason, leavingText, loginUrl, onLeaving, resetSignedOut, setSignedIn, watchFetch } from "../src/lib/signed-out.ts";

const ORIGIN = "https://hub.example";
const answer = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });
// A Response made here has no url; fetch's have the one asked.
const at = (r: Response, url: string) => Object.defineProperty(r, "url", { value: url });

beforeEach(() => {
  resetSignedOut();
  (globalThis as { location?: unknown }).location = { origin: ORIGIN, pathname: "/ada", search: "", hash: "#files", assign() {} };
});

test("a front-door refusal ends the session, signed in or not", () => {
  assert.equal(endsSession(at(answer(401, { [DENIED_HEADER]: "sign-in" }), `${ORIGIN}/-/api/view`), false, ORIGIN), true);
  assert.equal(endsSession(at(answer(401, { [DENIED_HEADER]: "sign-in" }), `${ORIGIN}/-/api/view`), true, ORIGIN), true);
});

test("the hub's own 401 ends it only for a viewer who was signed in, and only from this hub", () => {
  assert.equal(endsSession(at(answer(401), `${ORIGIN}/-/api/workers`), true, ORIGIN), true);
  assert.equal(endsSession(at(answer(401), `${ORIGIN}/-/api/workers`), false, ORIGIN), false, "a guest asked for something that needs signing in");
  assert.equal(endsSession(at(answer(401), "https://elsewhere.example/x"), true, ORIGIN), false);
  for (const status of [200, 403, 404, 500]) assert.equal(endsSession(at(answer(status, { [DENIED_HEADER]: "sign-in" }), `${ORIGIN}/`), true, ORIGIN), false, String(status));
});

test("the sign-in page gets the reason and a local way back", () => {
  assert.equal(loginUrl("suspended", "/ada#files"), "/-/login?reason=suspended&next=%2Fada%23files");
  assert.equal(loginUrl("signed-out", "//evil.example"), "/-/login?reason=signed-out&next=%2F");
  assert.equal(loginUrl("signed-out", "/-/login?next=/x"), "/-/login?reason=signed-out&next=%2F", "never back to sign-in itself");
  assert.equal(leavingText("suspended"), "Your access to this hub was suspended by its owner.");
  assert.equal(leavingText("signed-out"), "Sign in to continue.");
});

test("leaving happens once: views are told, and the page goes to sign in", () => {
  const went: string[] = [];
  let told = 0;
  onLeaving(() => told++);
  leave("signed-out", url => went.push(url));
  leave("suspended", url => went.push(url));
  assert.equal(leavingReason(), "signed-out");
  assert.equal(told, 1);
  assert.deepEqual(went, ["/-/login?reason=signed-out&next=%2Fada%23files"]);
});

test("every fetch is watched: a 401 from the front door takes the app to sign in, and the caller still gets its answer", async () => {
  const went: string[] = [];
  (globalThis as { location: { assign(url: string): void } }).location.assign = url => void went.push(url);
  let next = at(answer(200), `${ORIGIN}/-/api/view`);
  const target = { fetch: (async () => next) as typeof fetch };
  watchFetch(target);
  setSignedIn(true);
  assert.equal((await target.fetch("/-/api/view")).status, 200);
  assert.equal(leavingReason(), null);
  next = at(answer(401, { [DENIED_HEADER]: "sign-in" }), `${ORIGIN}/-/api/view`);
  assert.equal((await target.fetch("/-/api/view")).status, 401);
  assert.equal(leavingReason(), "signed-out");
  assert.deepEqual(went, ["/-/login?reason=signed-out&next=%2Fada%23files"]);
});
