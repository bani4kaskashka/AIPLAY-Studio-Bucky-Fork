/**
 * A FRESH ENGINE BEFORE AN H3 CLIP, WHERE A USED ONE RUNS AT HALF SPEED.
 *
 * Measured 2026-09-24 on an RX 9060 XT (ROCm, Windows, dynamic VRAM), H3
 * 1344x768, 8 steps: a fresh engine process sampled at ~82 s a step, the
 * next render in the same process at ~152 s (4.1 GB spilled to shared
 * memory). ComfyUI's /free with unload_models did not bring it back; a
 * restarted engine did (78 s). So art.js restarts an engine that has
 * rendered anything before an H3 or FastH3 clip, on any card but NVIDIA
 * unless the person says otherwise (video_settings free_before_clip).
 *
 *   node --test server/fresh-engine_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { clipNeedsCleanCard } = await import("./art.js");
const { config } = await import("./config.js");

test("which clips start on a fresh engine", () => {
  for (const vendor of ["amd", "intel", null]) assert.equal(clipNeedsCleanCard("h3", { vendor }), true, `H3 on ${vendor}`);
  assert.equal(clipNeedsCleanCard("fasth3", { vendor: "amd" }), true, "FastH3 is the same model family");
  assert.equal(clipNeedsCleanCard("h3", { vendor: "nvidia" }), false, "not seen on NVIDIA: auto leaves it alone");
  assert.equal(clipNeedsCleanCard("h3", { vendor: "nvidia", mode: "always" }), true);
  assert.equal(clipNeedsCleanCard("h3", { vendor: "amd", mode: "never" }), false);
  assert.equal(clipNeedsCleanCard("ltx", { vendor: "amd", mode: "always" }), false, "measured on H3 only");
  assert.equal(config.video.freeBeforeClip, "auto");
});

test("the clip job restarts a used engine, and only a used one", () => {
  const art = read("./art.js");
  assert.match(art, /if \(clipNeedsCleanCard\(engine, \{ mode: config\.video\.freeBeforeClip, vendor: vendorOf\(config\.gpu, config\.torchBackend\) \}\)\s*&& engineDoor\.ranSinceStart\(\) > 0 && typeof this\.comfy\?\.restart === "function"\) \{/);
  assert.match(art, /await this\.comfy\.restart\(\)\.catch\(/, "a failed restart is said, and the clip still goes");
  assert.match(art, /this\.jobs\.loaded = null;\s*this\.jobs\.artResident = true;\s*this\.#lastQwen = null;/, "nothing is warm afterwards");
  assert.ok(art.indexOf("clipNeedsCleanCard(engine,") < art.indexOf("for (let attempt = 0; ; attempt++) {", art.indexOf("clipNeedsCleanCard(engine,")),
    "before the clip is submitted");
});

test("the engine counts its own renders and forgets them when a new process attaches", () => {
  const client = read("./engine/client.js");
  assert.match(client, /function attachChild\(proc\) \{ child = proc \|\| null; ranSinceStart = 0; return child; \}/);
  assert.match(client, /if \(status === "completed" && !data\.cached\) ranSinceStart\+\+;/, "a cache hit ran nothing");
  assert.match(client, /ranSinceStart: \(\) => ranSinceStart,/);
  const comfy = read("./comfy.js");
  assert.match(comfy, /async restart\(\) \{\s*await this\.stop\(\);\s*await this\.start\(\);\s*return this\.assertBackend\(\);\s*\}/, "same flags, a new process");
});

test("the setting is a Video Lab row, and says what was measured", () => {
  const cat = read("./videolab/catalog.js");
  assert.match(cat, /id: "free_before_clip",[\s\S]{0,120}kind: "enum", options: \["auto", "always", "never"\],\s*path: \["video", "freeBeforeClip"\],/);
  assert.match(cat, /unloading the models did not help, a restart did/);
});
