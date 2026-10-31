# Whose Song Is It? — notes for Claude

Unofficial companion game for Greg's Music League: players guess who submitted each song in a round, then the host reveals the real submitters and the game scores it.

- Live site: https://whose-song-is-it.netlify.app (Netlify project owned by Greg, deploys automatically from `main` of gregdgardner/whose-song-is-it).
- `public/index.html` is the whole front end (no build step). Styling: charcoal app bar with a purple edge, Poppins + Archivo, light theme only. Keep it related to Music League but not a copy; keep the "unofficial, not affiliated" footer.
- `netlify/functions/api.mjs` is the server (Netlify Functions v2 + Netlify Blobs store "game"). Other players' picks are only returned for revealed rounds; answers are only stored at reveal.
- Players pick a name with no login; the first device to pick a name owns it (token in localStorage). The host can unlock a name on the Host tab. The host code is set by whoever first enters one on the Host tab.
- Blobs reads can lag right after a write, so the page keeps the chosen name and picks locally and never clears them just because the server hasn't caught up.
- Players press Submit to send picks; they can resubmit until the reveal.
- Scoring: 1 point per correct match, +3 for a perfect round; a player's own song never counts. Leaderboard is cumulative across revealed rounds.
- Claude can't reach netlify.app or the Netlify API from its sandbox. To add a round for Greg, append it to `netlify/functions/imports.mjs` (id, site, title, prompt, playlist, players, songs[{id,title,artist}], createdAt) and push. `site` is the Netlify project name of the league it belongs to (default `whose-song-is-it`); each league is its own Netlify site deployed from this same repo, with its own data and host code. The round it is added once on the next page load and stays deleted if the host deletes it.
- Spotify playlist tracks can be read with WebFetch on `https://open.spotify.com/embed/playlist/<id>`.
- Player names come from Music League's `competitors.csv` (ID,Name); duplicate names get " (2)". The Host tab can also load that CSV directly.
- Test locally by swapping `@netlify/blobs` for an in-memory mock and driving the page with Playwright.

Ideas Greg raised but has not asked to build yet: a $5 pot, separate copies of the site per league, a real App Store app.
