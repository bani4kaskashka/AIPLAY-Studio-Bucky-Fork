/**
 * TAOMATE IS OPTIONAL, AND 3 STEPS SAYS SO.
 *
 * The TaoMate 3-step LoRA is not required: nothing asks for it at start. A
 * render asking for 3 steps (or fewer) without it on disk used to load the
 * slot's fallback, a 4-step file name that may not be there either, and run
 * a 4-step build at 3 steps. Now it is refused with one sentence and the
 * download offered (needsModel), the Video screen says so while the slider
 * sits there, and a TaoMate download that lands is used without a restart.
 *
 *   node --test server/taomate_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { config } = await import("./config.js");
const { videoPlan, taomateNeeded, TAOMATE_ROW } = await import("./video-plain.js");

const h3 = (three) => ({ ...config.video.engines.h3, turboBuilds: { three, four: false, eight: true } });
const plan = (b, eng, engineKey = "h3") => videoPlan({ prompt: "a kite over a hill", width: 1344, height: 768, seconds: 5, ...b }, { engineKey, eng });

test("3 steps without TaoMate is refused, with the download offered", () => {
  for (const steps of [3, 2]) {
    const p = plan({ steps }, h3(false));
    assert.equal(p.refusal?.reason, "taomate-missing", `${steps} steps is refused`);
    assert.equal(p.refusal.needsModel, TAOMATE_ROW, "the reply names the row, so the page opens its download");
    assert.equal(p.refusal.error, taomateNeeded(steps));
  }
  assert.equal(TAOMATE_ROW, "videoH3Turbo3Small", "the 182 MB file new installs are offered");
  assert.match(taomateNeeded(3), /^3 steps needs the TaoMate 3-step LoRA \(182 MB\), which is not downloaded\. Download it, or pick 4 or more steps\.$/);
  assert.doesNotMatch(taomateNeeded(3), /—/, "no em dash in what a person reads");
});

test("everything else renders as before", () => {
  assert.equal(plan({ steps: 4 }, h3(false)).refusal, null, "4 steps needs no TaoMate");
  assert.equal(plan({ steps: 8 }, h3(false)).refusal, null, "8 steps needs no TaoMate");
  assert.equal(plan({ steps: 3 }, h3(true)).refusal, null, "with TaoMate on disk, 3 steps renders");
  assert.notEqual(plan({ steps: 3, refImages: ["a.png"] }, h3(false)).refusal?.reason, "taomate-missing",
    "the reference path runs its own build's count, not TaoMate's slot");
  const fast = { ...config.video.engines.fasth3 };
  assert.notEqual(plan({ steps: 3 }, fast, "fasth3").refusal?.reason, "taomate-missing", "FastH3's schedule is fixed");
  const { turboBuilds, ...unknown } = h3(false);
  assert.equal(plan({ steps: 3 }, unknown).refusal, null, "an engine that reports no builds is not judged");
});

test("the route hands the page the row, and the page warns first", () => {
  const index = read("./index.js");
  assert.match(index, /if \(plan\.refusal\) return json\(res, 400, \{ error: plan\.refusal\.error, reason: plan\.refusal\.reason,\s*\.\.\.\(plan\.refusal\.needsModel \? \{ needsModel: plan\.refusal\.needsModel \} : \{\}\) \}\);/,
    "POST /api/video passes needsModel on, which the Video screen's Fix button opens");
  const app = read("../web/app.js");
  assert.match(app, /const noTaoMate = !fixedPath && !hasRefs && !!eng\.turboBuilds && !eng\.turboBuilds\.three\s*&& st <= \(eng\.turbo3MaxSteps \?\? 3\);/);
  assert.match(app, /\(noTaoMate \? " · ⚠ " \+ st \+ " steps needs TaoMate \(182 MB\): download it, or use 4 or more" : ""\)/);
  assert.match(index, /models\.on\("ready", \(id\) => \{\s*if \(CATALOG\.find\(\(c\) => c\.id === id\)\?\.fastPathFor === "video"\) refreshTaoMate\(\);/,
    "a Fast-setting download that lands is looked for again");
});

test("a TaoMate download that lands is used without a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taomate-"));
  try {
    const loras = path.join(dir, "models", "loras");
    fs.mkdirSync(loras, { recursive: true });
    for (const f of ["minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "minimax_h3_ref2v_turbo_8step_v0.1_comfyui_bf16.safetensors"]) {
      fs.writeFileSync(path.join(loras, f), "x");
    }
    const probe = `
      import fs from "node:fs"; import path from "node:path";
      const { config, refreshTaoMate } = await import(${JSON.stringify(new URL("./config.js", import.meta.url).href)});
      const h = config.video.engines.h3;
      const snap = () => ({ lora: h.turboLora3, three: h.turboBuilds.three, fast: h.stepDefaults.fast, standard: h.stepDefaults.standard, steps: h.steps });
      const before = snap();
      const nothing = refreshTaoMate();
      fs.writeFileSync(path.join(${JSON.stringify(loras)}, "minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors"), "x");
      const found = refreshTaoMate();
      console.log(JSON.stringify({ before, nothing, found, after: snap() }));`;
    const env = { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
      AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output") };
    delete env.AIPLAY_MUSIC_ONLY;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 60_000 });
    const r = JSON.parse(out.trim().split("\n").at(-1));
    assert.equal(r.before.three, false, "no TaoMate at start: no 3-step build");
    assert.equal(r.before.fast, 8, "and Fast is Standard's 8");
    assert.equal(r.nothing, false, "looking again with nothing new finds nothing");
    assert.equal(r.found, true);
    assert.equal(r.after.lora, "minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors");
    assert.equal(r.after.three, true);
    assert.equal(r.after.fast, 3, "Fast drops to 3 at once");
    assert.equal(r.after.standard, 8, "Standard stays");
    assert.equal(r.after.steps, r.before.steps, "the step count in use stays");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
