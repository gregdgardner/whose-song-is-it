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

// Guessing deadline. Music League's voting deadline goes here, so guessing locks before ML shows
// who submitted what. Stored as an ISO UTC string; shown in Pacific time.
const TZ = "America/Los_Angeles";
function tzOffsetMs(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// Accepts an ISO time with a zone ("2026-11-20T21:00:00-08:00", "...Z"), epoch milliseconds, or a
// zone-less "YYYY-MM-DDTHH:mm" read as Pacific time. Returns an ISO UTC string, null for blank, or undefined if invalid.
export function parseDeadline(v) {
  if (v === null || v === undefined || v === "") return null;
  let ms;
  if (typeof v === "number") ms = v;
  else {
    const str = String(v).trim();
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      ms = guess - tzOffsetMs(guess);
      ms = guess - tzOffsetMs(ms);
    } else ms = Date.parse(str);
  }
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > Date.UTC(2100, 0, 1)) return undefined;
  return new Date(ms).toISOString();
}
export function deadlineText(iso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " PT";
}
// Why guessing is shut for a round, or null if it's open.
function closedReason(round, now = Date.now()) {
  if (round.status !== "open") return "revealed";
  if (round.closedAt) return "closed";
  if (round.guessDeadline && now >= Date.parse(round.guessDeadline)) return "deadline";
  return null;
}
const BAD_DEADLINE = "Guessing due by must be a date and time, like 2026-11-20T21:00 (Pacific) or an ISO time with a zone.";
const normURL = u => String(u || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
const roundView = r => ({ ...r, guessDeadline: r.guessDeadline || null, closedAt: r.closedAt || null,
  guessDeadlineText: r.guessDeadline ? deadlineText(r.guessDeadline) : null, guessingOpen: !closedReason(r) });

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
    // Most times one name can be picked in this round (0 = no limit), usually the songs each player submits.
    perPlayer: Math.max(0, Math.min(20, parseInt(r.perPlayer, 10) || 0)),
    status: r.status === "revealed" ? "revealed" : "open",
    answers: r.status === "revealed" && r.answers ? r.answers : null,
    // Guessing locks at this time (ISO UTC, usually Music League's voting deadline). null = no deadline.
    guessDeadline: parseDeadline(r.guessDeadline) || null,
    // Set when the host closes guessing by hand before the deadline. null = not closed.
    closedAt: parseDeadline(r.closedAt) || null,
    createdAt: Number(r.createdAt) || Date.now(),
  };
}

// Optional server-side ping after a guess saves. No-ops unless both env vars are set
// (so sister sites without them stay unchanged). Failures are swallowed so the guess still succeeds.
async function notifyGuessSubmitted({ req, context, s, round, player, songsGuessed, firstSubmit }) {
  const url = process.env.GUESS_WEBHOOK_URL;
  const auth = process.env.GUESS_WEBHOOK_AUTH;
  if (!url || !auth) return;
  const payload = {
    event: "guess_submitted",
    site: siteName(req, context),
    roundId: round.id,
    roundTitle: round.title,
    player,
    songsGuessed,
    firstSubmit,
    guessDeadline: round.guessDeadline || null,
    timestamp: new Date().toISOString(),
  };
  try {
    payload.playerCount = (round.players || []).length;
    const { blobs } = await s.list({ prefix: `guesses/${round.id}/` });
    payload.submittedCount = blobs.length;
  } catch {}
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
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
    return json({ rounds, guesses: byRound, notes, started, claimed: claims, me, pinSet: me ? !!myClaim.pinHash : null, hostSet, now: Date.now() });
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
    const why = closedReason(round);
    if (why === "revealed") return fail("Guessing is closed for this round.", 409);
    if (why === "closed") return fail("The host closed guessing for this round. Guesses are locked until the reveal.", 409);
    if (why === "deadline") return fail(`Guessing closed ${deadlineText(round.guessDeadline)}. Guesses are locked until the reveal.`, 409);
    const songIds = new Set(round.songs.map(x => x.id));
    const clean = {};
    for (const [k, v] of Object.entries(picks || {})) if (songIds.has(k) && round.players.includes(v)) clean[k] = v;
    if (round.perPlayer) {
      const counts = {};
      for (const v of Object.values(clean)) counts[v] = (counts[v] || 0) + 1;
      const over = Object.keys(counts).find(p => counts[p] > round.perPlayer);
      if (over) return fail(`You picked ${over} ${counts[over]} times. Each name can be picked at most ${round.perPlayer} ${round.perPlayer === 1 ? "time" : "times"} this round.`);
    }
    // Optional note per pick, private until the round is revealed (same as picks).
    const cleanNotes = {};
    for (const [k, v] of Object.entries(body.notes || {})) { const t = String(v || "").trim().slice(0, 200); if (songIds.has(k) && t) cleanNotes[k] = t; }
    const guessKey = `guesses/${roundId}/${enc(player)}`;
    let firstSubmit = true;
    if (process.env.GUESS_WEBHOOK_URL && process.env.GUESS_WEBHOOK_AUTH) {
      try { firstSubmit = !(await s.get(guessKey, { type: "json" })); } catch {}
    }
    await s.setJSON(guessKey, { player, roundId, picks: clean, notes: cleanNotes, at: Date.now() });
    await notifyGuessSubmitted({ req, context, s, round, player, songsGuessed: Object.keys(clean).length, firstSubmit });
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
    const raw = body.round || {};
    if ("guessDeadline" in raw && parseDeadline(raw.guessDeadline) === undefined) return fail(BAD_DEADLINE);
    const r = cleanRound(raw);
    if (r.players.length < 2) return fail("Add at least two players.");
    if (!r.songs.length) return fail("Add the round's songs.");
    // Saving a round without these fields keeps what's stored, so an edit can't wipe a deadline by accident.
    const prev = await s.get("rounds/" + r.id, { type: "json" });
    if (prev && !("guessDeadline" in raw)) r.guessDeadline = prev.guessDeadline || null;
    if (prev && !("closedAt" in raw)) r.closedAt = prev.closedAt || null;
    await s.setJSON("rounds/" + r.id, r);
    return json({ ok: true, round: roundView(r) });
  }
  // Set or move a round's guessing deadline, or close/reopen guessing by hand, without resending the round.
  // Body: {code, roundId | playlist, guessDeadline?: ISO | "YYYY-MM-DDTHH:mm" (Pacific) | ms | null, closed?: bool}
  if (route === "host/deadline" && req.method === "POST") {
    let round = body.roundId ? await s.get("rounds/" + String(body.roundId).replace(/[^\w-]/g, ""), { type: "json" }) : null;
    if (!round && body.playlist) round = (await listJSON(s, "rounds/")).map(([, r]) => r).find(r => r.playlist && normURL(r.playlist) === normURL(body.playlist)) || null;
    if (!round) return fail("That round doesn't exist.", 404);
    if (!("guessDeadline" in body) && !("closed" in body)) return fail("Send guessDeadline, closed, or both.");
    const next = { ...round };
    if ("guessDeadline" in body) {
      const d = parseDeadline(body.guessDeadline);
      if (d === undefined) return fail(BAD_DEADLINE);
      next.guessDeadline = d;
    }
    if ("closed" in body) next.closedAt = body.closed ? (round.closedAt || new Date().toISOString()) : null;
    await s.setJSON("rounds/" + round.id, next);
    return json({ ok: true, round: roundView(next) });
  }
  if (route === "host/delete" && req.method === "POST") {
    const id = String(body.id || "");
    await s.delete("rounds/" + id);
    const { blobs } = await s.list({ prefix: `guesses/${id}/` });
    await Promise.all(blobs.map(b => s.delete(b.key)));
    return json({ ok: true });
  }
  // Reads a Spotify playlist's tracks from its public embed page, so the host only has to paste the link.
  if (route === "host/playlist" && req.method === "POST") {
    const id = (String(body.url || "").match(/playlist[\/:]([A-Za-z0-9]{10,})/) || [])[1];
    if (!id) return fail("That doesn't look like a Spotify playlist link.");
    const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "accept-language": "en" },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (!res || !res.ok) return fail("Couldn't reach Spotify for that playlist. Try again, or load submissions.csv instead.", 502);
    const out = playlistFromEmbed(await res.text());
    if (!out.songs.length) return fail("Couldn't read the songs from that playlist. Load submissions.csv instead.", 502);
    return json({ ok: true, ...out });
  }
  if (route === "host/release" && req.method === "POST") {
    await s.delete("claims/" + enc(body.player));
    return json({ ok: true });
  }

  return fail("Not found.", 404);
}

// The embed page carries its data as JSON in <script> tags. Rather than depend on one exact layout,
// look for the longest list of track-like objects (a spotify:track uri, or a title plus an artist line).
export function playlistFromEmbed(html) {
  const blobs = [...String(html).matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let best = [], name = "";
  const artistOf = o => typeof o.subtitle === "string" ? o.subtitle
    : Array.isArray(o.artists) ? o.artists.map(a => a && (a.name || a.profile?.name)).filter(Boolean).join(", ") : "";
  const isTrack = o => o && typeof o === "object" && (typeof o.title === "string" || typeof o.name === "string")
    && ((typeof o.uri === "string" && o.uri.startsWith("spotify:track:")) || (typeof o.title === "string" && typeof o.subtitle === "string"));
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 40) return;
    if (Array.isArray(v)) {
      const tracks = v.filter(isTrack);
      if (tracks.length > best.length && tracks.length >= v.length / 2) best = tracks;
      v.forEach(x => walk(x, depth + 1));
      return;
    }
    if (!name && typeof v.type === "string" && v.type === "playlist" && typeof (v.name || v.title) === "string") name = v.name || v.title;
    for (const k in v) walk(v[k], depth + 1);
  };
  for (const b of blobs) { try { walk(JSON.parse(b), 0); } catch {} }
  const songs = best.map(o => ({
    // Spotify adds suffixes like " - 2003 Remaster"; drop them (the round's "Title - Artist" format splits on " - ").
    title: String(o.title || o.name).replace(/\s+-\s+.*$/, "").trim(),
    artist: artistOf(o).trim(),
  })).filter(x => x.title);
  return { name, songs };
}

export const config = { path: "/api/*" };
