# Whose Song Is It?

A side game for Music League: players guess who submitted each song in a round, and score points once the host reveals the real submitters.

## How it runs

- `public/index.html` is the whole page.
- `netlify/functions/api.mjs` is a small Netlify Function that saves rounds and guesses in Netlify Blobs (no database to set up).
- Other players' guesses stay on the server until a round is revealed.
- The first host code entered on the Host tab becomes the host code.

## Deploying on Netlify

1. In Netlify, choose **Add new site → Import an existing project → GitHub**, and pick this repository.
2. Leave the build settings as they are (`netlify.toml` sets them) and click **Deploy**.
3. Open the site, go to the **Host** tab, and set your host code right away.

## Scoring

1 point per song matched to the right person, plus 3 for a perfect round. A player's own song never counts.
