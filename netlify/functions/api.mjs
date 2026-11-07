import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";
import seed from "./seed.mjs";
import imports from "./imports.mjs";

// Keys in the "game" store:
//   rounds/<roundId>                 round (answers only present once revealed)
//   guesses/<roundId>/<player>       one player's picks for one round
//   claims/<player>                  {player, tokenHashes[], pinHash?, fails, failAt}: devices that own a player name, and its PIN
//   meta/host                        hash of the host code
//   meta/seeded                      set once the bundled seed has been loaded
//   meta/imported/<roundId>          set once a round from imports.mjs has been added (so deleting it sticks)

const store = () => getStore({ name: "game", consistency: "strong" });
// Player names can hold any character, so keys use a short hash of the name instead.
const enc = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 24);
const hash = s => createHash("sha256").update(String(s)).digest("hex");
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message, status = 400) => json({ error: message }, status);

async function listJSON(s, prefix) {
  const { blobs } = await s.list({ prefix });
  const out = await Promise.all(blobs.map(async b => [b.key, await s.get(b.key, { type: "json" })]));
  return out.filter(([, v]) => v != null);
}

// Several Netlify sites (one per league) deploy from this repo, each with its own Blobs store.
// Rounds in imports.mjs name the site they belong to; ones without a site belong to the first league's site.
const MAIN_SITE = "whose-song-is-it";
function siteName(req, context) {
  return context?.site?.name || process.env.SITE_NAME || new URL(req.url).hostname.split(".")[0].split("--").pop() || MAIN_SITE;
}

async function ensureSeeded(s, site) {
  for (const r of imports.rounds || []) {
    if ((r.site || MAIN_SITE) !== site) continue;
    if (await s.get("meta/imported/" + r.id)) continue;
    if (!(await s.get("rounds/" + r.id))) await s.setJSON("rounds/" + r.id, cleanRound(r));
    await s.set("meta/imported/" + r.id, new Date().toISOString());
  }
  if (site !== MAIN_SITE || await s.get("meta/seeded")) return;
  for (const r of seed.rounds || []) await s.setJSON("rounds/" + r.id, r);
  for (const g of seed.guesses || []) await s.setJSON(`guesses/${g.roundId}/${enc(g.player)}`, { player: g.player, roundId: g.roundId, picks: g.picks });
  await s.set("meta/seeded", new Date().toISOString());
}

// A name can be used on several devices: the first device sets a 4-digit PIN, and other devices join with it.
const pinHash = (player, pin) => hash("pin:" + player + ":" + pin);
const validPin = pin => /^\d{4}$/.test(String(pin || ""));
const tokensOf = c => c ? (c.tokenHashes || (c.tokenHash ? [c.tokenHash] : [])) : [];
const getClaim = (s, player) => s.get("claims/" + enc(player), { type: "json" });
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

async function ownsName(s, player, token) {
  if (!player || !token) return null;
  const claim = await getClaim(s, player);
  return claim && tokensOf(claim).includes(hash(token)) ? claim : null;
}

// Claims a name for this device. Returns null on success, or [message, status] on failure.
async function claimName(s, player, token, pin) {
  if (!player || !token || String(token).length < 16) return ["Pick your name first.", 403];
  if (pin != null && pin !== "" && !validPin(pin)) return ["The PIN must be 4 digits.", 400];
  const key = "claims/" + enc(player);
  const claim = await s.get(key, { type: "json" });
  const t = hash(token), tokens = tokensOf(claim);
  if (!claim) {
    await s.setJSON(key, { player, tokenHashes: [t], pinHash: validPin(pin) ? pinHash(player, pin) : null, at: Date.now() });
    return null;
  }
  if (tokens.includes(t)) {
    if (validPin(pin) && !claim.pinHash) await s.setJSON(key, { ...claim, tokenHashes: tokens, pinHash: pinHash(player, pin) });
    return null;
  }
  if (!claim.pinHash) return [`${player} is already playing on another device and hasn't set a PIN. Ask the host to unlock the name.`, 409];
  if (claim.fails >= MAX_FAILS && Date.now() - claim.failAt < LOCK_MS) return ["Too many wrong PINs. Try again in 15 minutes, or ask the host to unlock the name.", 429];
  if (!validPin(pin)) return [`Enter ${player}'s PIN to play on this device.`, 409];
  if (claim.pinHash !== pinHash(player, pin)) {
    const fails = (Date.now() - (claim.failAt || 0) < LOCK_MS ? claim.fails || 0 : 0) + 1;
    await s.setJSON(key, { ...claim, tokenHashes: tokens, fails, failAt: Date.now() });
    return ["That PIN isn't right.", 403];
  }
  await s.setJSON(key, { ...claim, tokenHashes: [...tokens, t].slice(-10), fails: 0, failAt: 0 });
  return null;
}

async function isHost(s, code) {
  if (!code) return false;
  const meta = await s.get("meta/host", { type: "json" });
  return !!meta && meta.codeHash === hash(code);
}

function cleanRound(r) {
  const players = [...new Set((r.players || []).map(p => String(p).trim()).filter(Boolean))];
  const songs = (r.songs || []).map(x => ({ id: String(x.id || randomBytes(4).toString("hex")), title: String(x.title || "").trim(), artist: String(x.artist || "").trim() }))
    .filter(x => x.title);
  return {
    id: String(r.id || randomBytes(5).toString("hex")).replace(/[^\w-]/g, ""),
    title: String(r.title || "Untitled round").trim(),
    prompt: String(r.prompt || "").trim(),
    playlist: /^https:\/\//.test(r.playlist || "") ? r.playlist : "",
    players, songs,
    status: r.status === "revealed" ? "revealed" : "open",
    answers: r.status === "revealed" && r.answers ? r.answers : null,
    createdAt: Number(r.createdAt) || Date.now(),
  };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { console.error(e); return fail("The game server hit a problem: " + (e && e.message || e), 500); }
};

async function handle(req, context) {
  const s = store();
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  await ensureSeeded(s, siteName(req, context));

  // Everything the page needs. Other players' picks are only sent for revealed rounds.
  if (route === "state" && req.method === "POST") {
    const rounds = (await listJSON(s, "rounds/")).map(([, r]) => r);
    const guesses = await listJSON(s, "guesses/");
    const claims = (await listJSON(s, "claims/")).map(([, c]) => c.player);
    const myClaim = await ownsName(s, body.player, body.token);
    const me = myClaim ? body.player : null;
    const byRound = {};
    const notes = {};
    const started = {};
    for (const [, g] of guesses) {
      const roundId = g.roundId;
      const round = rounds.find(r => r.id === roundId);
      if (!round) continue;
      if (Object.keys(g.picks || {}).length) started[roundId] = (started[roundId] || 0) + 1;
      if (round.status === "revealed" || g.player === me) {
        (byRound[roundId] ||= {})[g.player] = g.picks || {};
        if (g.notes && Object.keys(g.notes).length) (notes[roundId] ||= {})[g.player] = g.notes;
      }
    }
    const hostSet = !!(await s.get("meta/host"));
    return json({ rounds, guesses: byRound, notes, started, claimed: claims, me, pinSet: me ? !!myClaim.pinHash : null, hostSet });
  }

  // A device claims a player name: new names set a PIN, and other devices join with that PIN.
  // An owning device can also add a PIN to a name that doesn't have one yet.
  if (route === "claim" && req.method === "POST") {
    const err = await claimName(s, body.player, body.token, body.pin);
    return err ? fail(...err) : json({ ok: true });
  }

  if (route === "guess" && req.method === "POST") {
    const { player, token, roundId, picks } = body;
    const err = await claimName(s, player, token, body.pin);
    if (err) return fail(err[0], err[1] === 400 ? 400 : 403);
    const round = await s.get("rounds/" + roundId, { type: "json" });
    if (!round) return fail("That round no longer exists.", 404);
    if (round.status !== "open") return fail("Guessing is closed for this round.", 409);
    const songIds = new Set(round.songs.map(x => x.id));
    const clean = {};
    for (const [k, v] of Object.entries(picks || {})) if (songIds.has(k) && round.players.includes(v)) clean[k] = v;
    // Optional note per pick, private until the round is revealed (same as picks).
    const cleanNotes = {};
    for (const [k, v] of Object.entries(body.notes || {})) { const t = String(v || "").trim().slice(0, 200); if (songIds.has(k) && t) cleanNotes[k] = t; }
    await s.setJSON(`guesses/${roundId}/${enc(player)}`, { player, roundId, picks: clean, notes: cleanNotes, at: Date.now() });
    return json({ ok: true });
  }

  // Host: the first code entered becomes the host code.
  if (route === "host/login" && req.method === "POST") {
    const code = String(body.code || "");
    if (code.length < 4) return fail("Use a host code of at least 4 characters.");
    const meta = await s.get("meta/host", { type: "json" });
    if (!meta) { await s.setJSON("meta/host", { codeHash: hash(code), at: Date.now() }); return json({ ok: true, created: true }); }
    return meta.codeHash === hash(code) ? json({ ok: true }) : fail("That host code isn't right.", 403);
  }

  if (route.startsWith("host/") && !(await isHost(s, body.code))) return fail("Enter the host code first.", 403);

  if (route === "host/round" && req.method === "POST") {
    const r = cleanRound(body.round || {});
    if (r.players.length < 2) return fail("Add at least two players.");
    if (!r.songs.length) return fail("Add the round's songs.");
    await s.setJSON("rounds/" + r.id, r);
    return json({ ok: true, round: r });
  }
  if (route === "host/delete" && req.method === "POST") {
    const id = String(body.id || "");
    await s.delete("rounds/" + id);
    const { blobs } = await s.list({ prefix: `guesses/${id}/` });
    await Promise.all(blobs.map(b => s.delete(b.key)));
    return json({ ok: true });
  }
  if (route === "host/release" && req.method === "POST") {
    await s.delete("claims/" + enc(body.player));
    return json({ ok: true });
  }

  return fail("Not found.", 404);
}

export const config = { path: "/api/*" };
