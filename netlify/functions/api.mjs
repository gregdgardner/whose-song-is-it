import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";
import seed from "./seed.mjs";

// Keys in the "game" store:
//   rounds/<roundId>                 round (answers only present once revealed)
//   guesses/<roundId>/<player>       one player's picks for one round
//   claims/<player>                  hash of the browser token that owns a player name
//   meta/host                        hash of the host code
//   meta/seeded                      set once the bundled seed has been loaded

const store = () => getStore({ name: "game", consistency: "strong" });
const enc = s => encodeURIComponent(String(s));
const hash = s => createHash("sha256").update(String(s)).digest("hex");
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message, status = 400) => json({ error: message }, status);

async function listJSON(s, prefix) {
  const { blobs } = await s.list({ prefix });
  const out = await Promise.all(blobs.map(async b => [b.key, await s.get(b.key, { type: "json" })]));
  return out.filter(([, v]) => v != null);
}

async function ensureSeeded(s) {
  if (await s.get("meta/seeded")) return;
  for (const r of seed.rounds || []) await s.setJSON("rounds/" + r.id, r);
  for (const g of seed.guesses || []) await s.setJSON(`guesses/${g.roundId}/${enc(g.player)}`, { player: g.player, roundId: g.roundId, picks: g.picks });
  await s.set("meta/seeded", new Date().toISOString());
}

async function ownsName(s, player, token) {
  if (!player || !token) return false;
  const claim = await s.get("claims/" + enc(player), { type: "json" });
  return !!claim && claim.tokenHash === hash(token);
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

export default async (req) => {
  const s = store();
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  await ensureSeeded(s);

  // Everything the page needs. Other players' picks are only sent for revealed rounds.
  if (route === "state" && req.method === "POST") {
    const rounds = (await listJSON(s, "rounds/")).map(([, r]) => r);
    const guesses = await listJSON(s, "guesses/");
    const claims = (await listJSON(s, "claims/")).map(([, c]) => c.player);
    const me = (await ownsName(s, body.player, body.token)) ? body.player : null;
    const byRound = {};
    const started = {};
    for (const [, g] of guesses) {
      const roundId = g.roundId;
      const round = rounds.find(r => r.id === roundId);
      if (!round) continue;
      if (Object.keys(g.picks || {}).length) started[roundId] = (started[roundId] || 0) + 1;
      if (round.status === "revealed" || g.player === me) (byRound[roundId] ||= {})[g.player] = g.picks || {};
    }
    const hostSet = !!(await s.get("meta/host"));
    return json({ rounds, guesses: byRound, started, claimed: claims, me, hostSet });
  }

  // A browser claims a player name; the first browser to claim it owns it.
  if (route === "claim" && req.method === "POST") {
    const { player, token } = body;
    if (!player || !token || String(token).length < 16) return fail("Pick a name first.");
    const key = "claims/" + enc(player);
    const claim = await s.get(key, { type: "json" });
    if (claim && claim.tokenHash !== hash(token)) return fail(`${player} is already playing on another device. Ask the host to unlock the name.`, 409);
    if (!claim) await s.setJSON(key, { player, tokenHash: hash(token), at: Date.now() });
    return json({ ok: true });
  }

  if (route === "guess" && req.method === "POST") {
    const { player, token, roundId, picks } = body;
    if (!(await ownsName(s, player, token))) return fail("This device isn't signed in as " + player + ".", 403);
    const round = await s.get("rounds/" + roundId, { type: "json" });
    if (!round) return fail("That round no longer exists.", 404);
    if (round.status !== "open") return fail("Guessing is closed for this round.", 409);
    const songIds = new Set(round.songs.map(x => x.id));
    const clean = {};
    for (const [k, v] of Object.entries(picks || {})) if (songIds.has(k) && round.players.includes(v)) clean[k] = v;
    await s.setJSON(`guesses/${roundId}/${enc(player)}`, { player, roundId, picks: clean, at: Date.now() });
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
};

export const config = { path: "/api/*" };
