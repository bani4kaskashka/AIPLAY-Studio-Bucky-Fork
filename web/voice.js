/* THE MIC BUTTON (Chat and My pages): say a prompt instead of typing it.
 *
 * Recorded in the browser (MediaRecorder, the way Hum a melody does it), sent
 * once to POST /api/voice, transcribed by the timed-lyrics whisper on Studio's
 * queue (server/voice.js). The words are ADDED to the box for the person to
 * read and edit; nothing is sent on their behalf. */
/* setup-feature.js is loaded only when a refusal names a setup: it touches the
 * page when it loads, and chat.js (which imports this) is also read by tests. */

const MAX_MS = 2 * 60_000;
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const WORDS = { idle: "Record your request", rec: "Stop recording", busy: "Writing down what you said" };
const IDLE_TITLE = "Say it instead of typing. Whisper writes it into the box.";

/**
 * `button` holds the mic icon and a .sr-only label; `box` is the textarea the
 * words go into; `say(text, warn)` shows a status line; `after()` runs once
 * the box changed (resize it, repaint a Send button).
 */
export function wireMic(button, { box, say, after = () => {} }) {
  let rec = null;               // { recorder, stream, chunks, stopTimer, tick }

  function paint(state) {
    button.dataset.state = state;
    button.setAttribute("aria-pressed", state === "rec" ? "true" : "false");
    button.disabled = state === "busy";
    const label = button.querySelector(".sr-only");
    if (label) label.textContent = WORDS[state];
    button.title = state === "idle" ? IDLE_TITLE : WORDS[state];
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { say("This browser cannot record here.", true); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { say(`The microphone could not be opened: ${err.message || err}`, true); return; }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const started = Date.now();
    const mine = { recorder, stream, chunks: [] };
    rec = mine;
    recorder.ondataavailable = (e) => { if (e.data?.size) mine.chunks.push(e.data); };
    recorder.onstop = () => send(new Blob(mine.chunks, { type: recorder.mimeType || type || "audio/webm" }));
    recorder.start();
    mine.stopTimer = setTimeout(stop, MAX_MS);
    const tick = () => say(`Listening… ${Math.round((Date.now() - started) / 1000)} s. Press the mic again when you are done.`);
    tick(); mine.tick = setInterval(tick, 1000);
    paint("rec");
  }

  function stop() {
    if (!rec) return;
    clearTimeout(rec.stopTimer); clearInterval(rec.tick);
    rec.stream.getTracks().forEach((t) => t.stop());
    if (rec.recorder.state !== "inactive") rec.recorder.stop();
  }

  async function send(blob) {
    rec = null;
    if (blob.size < 800) { paint("idle"); say("Nothing was recorded.", true); return; }
    paint("busy");
    say("Whisper is writing down what you said…");
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: btoa(bin), type: blob.type }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        if (d.setup) (await import("./setup-feature.js")).offerSetup(d.setup, d.error);
        throw new Error(d.error || `Studio answered ${r.status}.`);
      }
      const text = String(d.text || "").trim();
      if (!text) { say("Whisper heard no words. Try again a little closer to the mic.", true); return; }
      box.value = box.value.trim() ? `${box.value.trimEnd()} ${text}` : text;
      say("Added to the box. Check it, then send.");
      after();
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    } catch (err) {
      say(err.message, true);
    } finally {
      paint("idle");
    }
  }

  paint("idle");
  button.addEventListener("click", () => (rec ? stop() : start()));
}
