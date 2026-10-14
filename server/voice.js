/**
 * VOICE PROMPTS: the mic button in Chat and My pages (web/voice.js).
 *
 *   POST /api/voice {audio: base64, type: "audio/webm"}  ->  {text}
 *
 * The browser records; index.js's `transcribe` hands the file to the
 * timed-lyrics whisper on the art queue and deletes it. Only the words come
 * back, and they go into a text box the person reads before sending anything.
 * Same-origin local JSON only: another web page cannot queue whisper. The
 * job is filed under the caller (actorFrom), like every other door.
 */
import { actorFrom } from "./provenance.js";

/** 4 MB of base64 is about 3 MB of audio: far past the two minutes the button records. */
const MAX_BODY = 4 * 1024 * 1024;

/** The browser's own recording formats, as a file extension; anything else is refused. */
export function voiceExt(type) {
  const t = String(type || "").toLowerCase();
  return /^audio\/webm/.test(t) ? "webm" : /^audio\/ogg/.test(t) ? "ogg" : /^audio\/(mp4|aac|x-m4a)/.test(t) ? "m4a" : null;
}

export function createVoiceRoute({ json, readBody, sameOriginLocalJson, transcribe }) {
  return async function route(req, res, url) {
    if (url.pathname !== "/api/voice") return false;
    if (req.method !== "POST") { json(res, 405, { error: "POST a recording." }); return true; }
    if (!sameOriginLocalJson(req)) { json(res, 403, { error: "Only Studio's own page can send a recording." }); return true; }
    let b;
    try { b = await readBody(req, MAX_BODY); } catch { json(res, 400, { error: "That recording is too long." }); return true; }
    const ext = voiceExt(b?.type);
    const bytes = typeof b?.audio === "string" ? Buffer.from(b.audio, "base64") : null;
    if (!ext || !bytes?.length) { json(res, 400, { error: "That recording could not be read." }); return true; }
    try { json(res, 200, { text: await transcribe(bytes, ext, actorFrom(req)) }); }
    catch (e) { json(res, 400, { error: String(e?.message || e), ...(e?.setup ? { setup: e.setup } : {}) }); }
    return true;
  };
}
