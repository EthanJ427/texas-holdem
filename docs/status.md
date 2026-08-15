# Project status

Last updated: 2026-08-15

## Live

| | |
|---|---|
| Game | https://ethanj427.github.io/texas-holdem/ (trailing slash, all lowercase) |
| Server | https://holdem.ethan-poker.workers.dev/health |
| Tests | https://ethanj427.github.io/texas-holdem/tests/ |

Both halves must be shipped separately: `git push` updates the page (GitHub Pages rebuilds in
about a minute), `npx wrangler deploy` updates the server. Pushing only one leaves the client
and server on different versions.

## What exists

**Solo** — six-max no-limit, three bot tiers (Novice / Intermediate / Expert, measured at 95% /
28% / 25% VPIP; Expert beats Novice by ~222 BB/100 over 1500 seeded hands). First-person 3D
table, chip stacks, Web Audio sound synthesis, localStorage save.

**Online** — room codes, bots fill empty seats so two players suffice. Reconnect restores seat
and stack. 60 seconds per decision, then the server checks or folds. Players arriving mid-hand
queue and are seated at the start of the next hand. Busting out offers a rebuy; bots rebuy
themselves so the table does not drain.

**Tests** — 287 assertions, run in a browser. Node on this machine exists only to install
wrangler; the tests do not need it.

## Architecture worth not rediscovering

- `js/engine.js`, `js/cards.js`, `js/ai.js`, `js/room.js` touch no browser API — the server
  reuses them unchanged.
- **State leaves the engine through exactly two exits**, each with a key allowlist enforced by
  tests: `viewFor(id)` → `VIEW_KEYS`, `eventsFor(id, events)` → `EVENT_KEYS`. Events carry no
  card data at all; showdown reveals come through state.
- Rendering reads a *view*, never the engine. Solo feeds it `engine.viewFor(0)`, online feeds it
  the server's. The UI does not decide which cards to show — it draws what the view contains, so
  a rendering mistake cannot expose an unsent hand.
- Full state is sent on every change, no deltas. ~1–2KB, 556 bytes compressed. Deltas were
  considered and rejected: a full snapshot is needed anyway for join and reconnect, so deltas
  would be a second mechanism rather than a replacement.
- Replay protection is hand number + action sequence. **The sequence check must run before the
  whose-turn check** — a raise reopens betting to the same player, and there the sequence is the
  only thing between a double-click and a double charge.
- Seats and chips change **only between hands**. Rebuys follow that rule: `rebuy` records an
  intent, `grantRebuys()` pays it out before the next deal, and only to a seat still holding
  zero — an all-in player has zero chips too, and must not collect for winning.
- Server shuffles with `crypto.getRandomValues`. `Math.random` is predictable.
- Game-simulation tests use a seeded PRNG; unseeded runs swing 38–368 BB/100 on the same code.

## Next, roughly in order

1. **Show who has disconnected** — the server already sends `connected`; the UI ignores it, so
   everyone just waits out the 60 seconds wondering why someone is slow. The client now keeps
   the seat summary (`seatInfo` in `ui.js`), so the data is already in hand.
2. **Wait for players before dealing** — one person joining starts the game immediately, so a
   friend arriving 30 seconds later has already missed hands.
3. **One bot is called "Bot 5"** — `BOT_NAMES` has five entries but six seats are filled at
   construction, so the last one falls through to the placeholder. Visible at every table.
4. **CI** — tests currently require opening a browser by hand.
5. **Screenshot in the README** — a visual project with no image on GitHub loses most visitors.
   Needs a real screenshot committed to the repo.
6. **Translate code comments to English** — comments throughout `js/` and `tests/` are still
   Chinese. Large mechanical pass, no user impact; worth its own session.

Deliberately not doing: spectator entry, chat, anti-collusion, escalating blinds, real money.

## Commands

```bash
cd /Users/ethan/texas-holdem
npx wrangler deploy      # ship the server
npx wrangler whoami      # check Cloudflare auth is still valid
git push origin main     # ship the page
```
