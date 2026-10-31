import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual shell components without browser effects or production data.
const built = await build({ absWorkingDir: fileURLToPath(new URL("..", import.meta.url)), entryPoints: ["src/shell/shell.tsx"], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"], logLevel: "silent" });
const compiled: { exports: Record<string, ComponentType<any>> } = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { TopBar, Sidebar } = compiled.exports;
const nothing = () => {};

test("standalone recovery shell offers its own home without hub search or sign-in", () => {
  const props = { me: { checked: true, name: null }, signIn: "/-/login", live: "live", onSearch: nothing, onMenu: nothing };
  const standalone = renderToStaticMarkup(createElement(TopBar, { ...props, recoveryOnly: true }));
  assert.match(standalone, /href="\/#\/subhubs"/);
  assert.match(standalone, /Local recovery/);
  assert.doesNotMatch(standalone, /Sign in|Search spaces|\/-\/login/);
  const normal = renderToStaticMarkup(createElement(TopBar, props));
  assert.match(normal, /Search spaces/);
  assert.match(normal, /Sign in/);
});

test("standalone recovery sidebar hides spaces, recent places and hub footer links", () => {
  const props = {
    switcher: { current: null, options: [] }, primary: [{ key: "recovery", label: "Sub-hubs", href: "/#/subhubs", icon: null, active: true }],
    sections: [{ key: "recent", title: "Recent", limit: 4, items: [{ key: "project", label: "org/project", href: "/org/project", icon: null }] }],
    footer: [{ key: "guide", label: "Guide", href: "/-/guide", icon: null }], open: false, onClose: nothing, rail: false, onRail: nothing, onSearch: nothing,
  };
  const standalone = renderToStaticMarkup(createElement(Sidebar, { ...props, recoveryOnly: true }));
  assert.match(standalone, /Sub-hubs/);
  assert.doesNotMatch(standalone, /All spaces|Search|Recent|org\/project|Guide/);
  const normal = renderToStaticMarkup(createElement(Sidebar, props));
  assert.match(normal, /All spaces/);
  assert.match(normal, /Search/);
  assert.match(normal, /org\/project/);
  assert.match(normal, /Guide/);
});
