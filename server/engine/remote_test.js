import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { createWorker } from "../../worker/runpod-worker.js";
import { createRemoteClient } from "./remote-client.js";
import { endpoint, relativeFile, sendJSON, readBody, validateGraph, inputChoices } from "./remote-common.js";

const TOKEN = "test-only-worker-token-32-characters-long";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const graph = () => ({ "1": { class_type: "TestSave", inputs: { model: "demo.safetensors", text: "hello", filename_prefix: "test" } } });
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function rig(t, { dropSubmit = false, targetedCancel = true, clientFetch = fetch, appendOverride, adoptOutput = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-test-"));
  const inputDir = path.join(root, "input"), outputDir = path.join(root, "output"), stateDir = path.join(root, "worker-state");
  await Promise.all([inputDir, outputDir].map(d => mkdir(d, { recursive: true })));
  let submissions = 0, globalInterrupts = 0;
  const queue = [], history = {}, events = [];
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    if (url.pathname === "/system_stats") return sendJSON(res, 200, { system: { comfyui_version: "test" }, devices: [{ name: "FAKE GPU", vram_total: 24000000000 }] });
    if (url.pathname === "/object_info") {
      const assets = await readdir(path.join(inputDir, "aiplay_remote")).catch(() => []);
      return sendJSON(res, 200, {
        TestSave: { input: { required: { model: [["demo.safetensors"]], text: ["STRING"], filename_prefix: ["STRING"] } } },
        LoadImage: { input: { required: { image: [assets.map(n => `aiplay_remote/${n}`)] } } },
      });
    }
    if (url.pathname === "/prompt") {
      const b = JSON.parse((await readBody(req)).toString()); submissions++;
      const id = randomUUID(); queue.push([0, id, b.prompt, b.extra_data]);
      if (dropSubmit) { req.socket.destroy(); return; }
      return sendJSON(res, 200, { prompt_id: id });
    }
    if (url.pathname === "/queue") {
      if (req.method === "POST") {
        const b = JSON.parse((await readBody(req)).toString());
        for (const id of b.delete || []) { const index = queue.findIndex(q => q[1] === id); if (index >= 0) queue.splice(index, 1); }
      }
      return sendJSON(res, 200, { queue_running: queue.slice(0, 1), queue_pending: queue.slice(1) });
    }
    if (url.pathname.startsWith("/history")) {
      const id = url.pathname.split("/")[2]; return sendJSON(res, 200, id ? history[id] ? { [id]: history[id] } : {} : history);
    }
    if (/^\/api\/jobs\/.+\/cancel$/.test(url.pathname)) {
      if (!targetedCancel) return sendJSON(res, 404, {});
      const id = url.pathname.split("/")[3];
      const index = queue.findIndex(q => q[1] === id);
      if (index >= 0) { const [row] = queue.splice(index, 1); history[id] = { prompt: row, status: { status_str: "error" } }; }
      return sendJSON(res, 200, {});
    }
    if (url.pathname === "/interrupt") globalInterrupts++;
    sendJSON(res, 404, {});
  });
  const comfyURL = await listen(fake);
  let worker = await createWorker({ token: TOKEN, comfyURL, inputDir, outputDir, stateDir, pollMs: 3600000 });
  let workerURL = await listen(worker.server);
  let savedToken;
  const clientOptions = { dataDir: path.join(root, "desktop"), outputDir: path.join(root, "local-output"),
    getToken: async () => savedToken, setToken: async value => { savedToken = value; },
    append: appendOverride || (async (scope, event) => { events.push(event); return { id: String(events.length) }; }),
    adopt: async ({ output }) => {
      if (!adoptOutput) return null;
      const localRoot = path.join(root, "local-output");
      await mkdir(path.join(localRoot, "images"), { recursive: true });
      const adopted = `images/${output.file}`;
      await rename(path.join(localRoot, output.localFile), path.join(localRoot, adopted));
      return adopted;
    },
    fetchFn: clientFetch, pollMs: 3600000 };
  let client = await createRemoteClient(clientOptions);
  await client.connect({ url: workerURL, token: TOKEN });
  t.after(async () => {
    client.close(); await worker.close(); await new Promise(r => fake.close(r));
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("aiplay-remote-test-"));
    await rm(resolved, { recursive: true, force: true });
  });
  return {
    get client() { return client; }, get worker() { return worker; }, get workerURL() { return workerURL; },
    root, inputDir, outputDir, events, queue, history, get submissions() { return submissions; }, get globalInterrupts() { return globalInterrupts; },
    async restartClient() { client.close(); client = await createRemoteClient(clientOptions); },
    async restartWorker() {
      const port = worker.server.address().port; await worker.close();
      worker = await createWorker({ token: TOKEN, comfyURL, inputDir, outputDir, stateDir, pollMs: 3600000 });
      await new Promise(r => worker.server.listen(port, "127.0.0.1", r));
    },
    async complete() {
      const row = queue.shift(); assert.ok(row);
      const filename = `${row[1]}.png`; await writeFile(path.join(outputDir, filename), PNG);
      history[row[1]] = { prompt: row, status: { completed: true, status_str: "success" }, outputs: { "1": { images: [{ filename, subfolder: "", type: "output" }] } } };
    },
    raw: async (route, init = {}) => fetch(`${workerURL}${route}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }),
  };
}

test("round trip: local ledger, remote execution, verified local output", async t => {
  const r = await rig(t);
  const submitted = await r.client.submit({ graph: graph(), label: "A test image" });
  assert.equal(r.events[0].type, "delegate"); assert.equal(r.submissions, 0);
  await r.client.tick(); await r.worker.tick(); assert.equal(r.submissions, 1);
  await r.complete(); await r.worker.tick(); await r.client.tick();
  const job = r.client.status().jobs[0]; assert.equal(job.state, "completed");
  assert.deepEqual(await readFile(path.join(r.root, "local-output", job.outputs[0].localFile)), PNG);
  assert.equal(r.events[1].type, "generate"); assert.equal(r.events[1].data.remote.jobId, submitted.id);
  assert.ok(r.events[1].data.remote.executedGraphHash);
  assert.equal(JSON.stringify(r.client.status()).includes(TOKEN), false);
});

test("failed provenance write prevents every render submission", async t => {
  const r = await rig(t, { appendOverride: async () => { throw new Error("ledger unavailable"); } });
  await assert.rejects(r.client.submit({ graph: graph() }), /ledger unavailable/);
  await r.client.tick(); await r.worker.tick(); assert.equal(r.submissions, 0);
});

test("adopted library filename is retained in the completion record", async t => {
  const r = await rig(t, { adoptOutput: true });
  await r.client.submit({ graph: graph() }); await r.client.tick(); await r.worker.tick();
  await r.complete(); await r.worker.tick(); await r.client.tick();
  const output = r.client.status().jobs[0].outputs[0];
  assert.equal(output.localFile, output.adoptedAs);
  assert.match(output.adoptedAs, /^images\//);
  assert.deepEqual(await readFile(path.join(r.root, "local-output", output.adoptedAs)), PNG);
  assert.equal(r.events[1].data.outputs[0].adoptedAs, output.adoptedAs);
});

test("lost desktop submission response retries the same ID without duplicate GPU work", async t => {
  let lose = true;
  const r = await rig(t, { clientFetch: async (url, init) => {
    const response = await fetch(url, init);
    if (lose && url.endsWith("/v1/jobs") && init.method === "POST") { lose = false; await response.arrayBuffer(); throw new Error("lost"); }
    return response;
  } });
  await r.client.submit({ graph: graph() }); await r.client.tick();
  await r.worker.tick(); await r.client.tick();
  assert.equal(r.submissions, 1); assert.equal(Object.keys(r.worker.state.jobs).length, 1);
});

test("worker reconciles a lost ComfyUI response without resubmitting", async t => {
  const r = await rig(t, { dropSubmit: true });
  await r.client.submit({ graph: graph() }); await r.client.tick(); await r.worker.tick();
  assert.equal(Object.values(r.worker.state.jobs)[0].state, "submitting");
  await r.worker.tick(); assert.equal(Object.values(r.worker.state.jobs)[0].state, "running"); assert.equal(r.submissions, 1);
});

test("desktop and worker restart recover a running job and its output", async t => {
  const r = await rig(t);
  await r.client.submit({ graph: graph() }); await r.client.tick(); await r.worker.tick();
  await r.restartClient(); await r.restartWorker();
  await r.complete(); await r.worker.tick(); await r.client.tick();
  assert.equal(r.client.status().jobs[0].state, "completed"); assert.equal(r.submissions, 1);
});

test("references upload with content hashes and bind to remote relative paths", async t => {
  const r = await rig(t);
  const asset = await r.client.upload("reference.png", Readable.from(PNG));
  const g = graph(); g[2] = { class_type: "LoadImage", inputs: { image: "local-name.png" } };
  await r.client.submit({ graph: g, bindings: [{ node: "2", input: "image", asset: asset.asset }] });
  await r.client.tick(); await r.worker.tick();
  assert.equal(r.queue[0][2][2].inputs.image, `aiplay_remote/${asset.asset}`);
  assert.deepEqual(await readFile(path.join(r.inputDir, "aiplay_remote", asset.asset)), PNG);
});

test("unknown model is rejected before spending GPU time", async t => {
  const r = await rig(t); const g = graph(); g[1].inputs.model = "missing.safetensors";
  await r.client.submit({ graph: g }); await r.client.tick(); await r.worker.tick(); await r.client.tick();
  assert.equal(r.submissions, 0); assert.equal(r.client.status().jobs[0].state, "failed");
  assert.match(r.client.status().jobs[0].error, /does not offer/);
});

test("ComfyUI 0.37 COMBO descriptors preserve model validation", () => {
  const current = ["COMBO", { multiselect: false, options: ["demo.safetensors"] }];
  assert.deepEqual(inputChoices(current), ["demo.safetensors"]);
  assert.deepEqual(inputChoices([["demo.safetensors"]]), ["demo.safetensors"]);
  const info = { TestSave: { input: { required: {
    model: current, text: ["STRING"], filename_prefix: ["STRING"],
  } } } };
  assert.doesNotThrow(() => validateGraph(graph(), info));
  const missing = graph(); missing["1"].inputs.model = "missing.safetensors";
  assert.throws(() => validateGraph(missing, info), /does not offer/);
});

test("authentication, redirect policy and worker identity are enforced", async t => {
  const r = await rig(t);
  assert.equal((await fetch(`${r.workerURL}/v1/health`)).status, 401);
  assert.equal((await r.raw("/v1/health", { headers: { Origin: "https://other.example" } })).status, 403);
  await assert.rejects(r.client.connect({ url: r.workerURL, token: "x".repeat(32) }), /rejected/);
  r.worker.state.workerId = randomUUID();
  await assert.rejects(r.client.submit({ graph: graph() }), /identity changed/);
  assert.equal(r.submissions, 0);
});

test("changed output is not accepted locally", async t => {
  const r = await rig(t);
  await r.client.submit({ graph: graph() }); await r.client.tick(); await r.worker.tick(); await r.complete(); await r.worker.tick();
  const output = Object.values(r.worker.state.jobs)[0].outputs[0];
  await writeFile(path.join(r.outputDir, output.relative), Buffer.from("changed"));
  await r.client.tick();
  assert.equal(r.client.status().jobs[0].state, "downloading"); assert.equal(r.client.status().jobs[0].outputs.length, 0);
  assert.match(r.client.status().jobs[0].error, /changed/); assert.equal(r.events.length, 1);
});

test("active jobs allow token refresh but cannot switch worker or identity", async t => {
  const r = await rig(t);
  await r.client.submit({ graph: graph() }); await r.client.tick(); await r.worker.tick();
  await r.client.connect({ url: r.workerURL, token: TOKEN });
  await assert.rejects(r.client.connect({ url: "https://another-worker.example", token: TOKEN }), /changing workers/);
  const original = r.worker.state.workerId;
  r.worker.state.workerId = randomUUID();
  await assert.rejects(r.client.connect({ url: r.workerURL, token: TOKEN }), /identity changed/);
  r.worker.state.workerId = original;
  await r.complete(); await r.worker.tick(); await r.client.tick();
  assert.equal(r.client.status().jobs[0].state, "completed"); assert.equal(r.submissions, 1);
});

test("cancellation is scoped and refuses an unsafe global interrupt fallback", async t => {
  const r = await rig(t, { targetedCancel: false });
  const a = await r.client.submit({ graph: graph() }); await r.client.tick(); await r.worker.tick();
  await assert.rejects(r.client.cancel(a.id), /HTTP 404/);
  assert.equal(r.queue.length, 1); assert.equal(r.globalInterrupts, 0);
});

test("queued and active cancellation do not cancel other work", async t => {
  const r = await rig(t);
  const first = await r.client.submit({ graph: graph() }); const second = await r.client.submit({ graph: graph() });
  await r.client.tick(); await r.worker.tick();
  await r.client.cancel(second.id); await r.client.tick();
  assert.equal(r.client.status().jobs.find(j => j.id === second.id).state, "cancelled");
  assert.equal(r.queue.length, 1);
  await r.client.cancel(first.id); await r.worker.tick(); await r.client.tick();
  assert.equal(r.client.status().jobs.find(j => j.id === first.id).state, "cancelled");
  assert.equal(r.globalInterrupts, 0);
});

test("idempotency conflict and hostile filenames are rejected", async t => {
  const r = await rig(t); const id = randomUUID();
  const submit = g => r.raw("/v1/jobs", { method: "POST", body: JSON.stringify({ id, graph: g }) });
  assert.equal((await submit(graph())).status, 202);
  assert.equal((await submit(graph())).status, 200);
  const other = graph(); other[1].inputs.text = "different";
  assert.equal((await submit(other)).status, 409);
  for (const value of ["../secret", "C:/secret", "..\\secret", "/etc/passwd", "CON.png", "file:stream", "folder/../file", "name. ", "bad?.png", "bad<name>.png"]) assert.throws(() => relativeFile(value));
  assert.throws(() => endpoint("http://public.example"));
  assert.throws(() => endpoint("https://user:password@worker.example"));
  assert.throws(() => endpoint("https://worker.example?token=secret"));
  assert.throws(() => validateGraph({ nodes: [] }));
});
