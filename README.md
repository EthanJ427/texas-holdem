# Texas Hold'em

**[▶ Play now](https://ethanj427.github.io/texas-holdem/)** — no install, no signup, works on phones.

Six-max no-limit hold'em in the browser. Play solo against three tiers of bots, or share a
room code and deal your friends in. Vanilla HTML/CSS/JS — no dependencies, no build step.

---

## Play with friends

Click **Play with friends**, pick a name and a room code, and send that code to whoever you want at
the table. Empty seats fill with bots, so two people are enough to start.

- Reconnect where you left off — your seat and stack survive a refresh
- 60 seconds per decision, then the server checks or folds for you
- Bots hold the seats until real players arrive
- Bust out and you can buy back in — you are dealt in again on the next hand

## The bots

*VPIP is the share of hands a player voluntarily puts money into preflop — calling or raising,
with the forced blinds excluded. It is the standard measure of how loose someone plays: a tight
regular sits around 22–28%, a habitual caller runs past 60%.*

| Tier | Style | Measured VPIP | How it decides |
|---|---|---|---|
| Novice | Calls almost anything, rarely folds | ~95% | Very loose thresholds, 80 simulations |
| Intermediate | Plays pot odds, bluffs occasionally | ~28% | Chen formula + 250 simulations |
| Expert | Positional, aggressive, sizes bets | ~25% | Chen formula + 500 simulations |

The middle and top tiers land inside the range real six-max regulars play. Head-to-head over
1500 seeded hands, Expert beats Novice by roughly **222 BB/100** — a crushing margin, which is
what you would expect against an opponent that never folds.

Two techniques do the work. Preflop, the [Chen formula](https://www.thepokerbank.com/strategy/basic/starting-hand-selection/chen-formula/)
scores the starting hand (AA = 20, 72o ≈ -1), adjusted for position and how many players remain —
ranges widen as the table shrinks, because folding your way through heads-up bleeds you dry.
Postflop, a Monte Carlo run deals the remaining cards out hundreds of times and counts how often
the hand wins, which prices draws correctly without any special-casing.

**The bots cannot see your cards.** They receive the same redacted view a human client gets, in
which every other player's hole cards are `null`. This is enforced structurally rather than by
convention, and a test suite watches it.

## Running it

Open `index.html` in a browser. That is the whole procedure for solo play.

Online play needs the server in `worker/` deployed to Cloudflare Workers:

```bash
npm install
npx wrangler deploy
```

## Layout

```
index.html        the table
style.css         all styling, including the 3D perspective
js/cards.js       card representation, shuffling, 5-7 card evaluation
js/engine.js      rules: betting rounds, blinds, side pots, showdown
js/ai.js          the bots
js/sound.js       Web Audio synthesis — no audio files anywhere
js/net.js         WebSocket client
js/room.js        server-side table logic (platform-free, fully tested)
js/ui.js          rendering and flow
worker/index.js   Cloudflare Durable Object shell
tests/            298 assertions, run in a browser
docs/protocol.md  the wire protocol
```

`cards.js`, `engine.js`, `ai.js` and `room.js` touch no browser API, so the server reuses them
unchanged. The engine is usable on its own:

```js
const g = new HoldemEngine({ players, smallBlind: 10, bigBlind: 20 });
g.startHand();
g.currentActor();       // whose turn
g.legalActions();       // what they may do
g.act('raise', 120);    // raise TO 120, not BY 120
g.viewFor(seatId);      // redacted snapshot — the only way state leaves the engine
```

## Tests

Open [`tests/`](https://ethanj427.github.io/texas-holdem/tests/). 298 assertions, no runner to
install. The ones that earn their keep:

- **Evaluator vs. theory** — 500,000 random seven-card deals, category frequencies compared against
  the known mathematical values. Every category lands within a few thousandths of a percent.
- **2,000-hand fuzz** — chip conservation checked at every step, never acts out of turn, every hand
  terminates.
- **Side pots** — including the case where a folded player contributed more than anyone still live,
  which silently vaporised chips before it was caught.
- **Redaction** — every view sent to every player is serialised and inspected. A key allowlist means
  any new field fails the test until it has been reviewed, and reverse controls assert that what
  *should* be visible is, so an empty return value cannot fake a pass.
- **Audio brightness** — spectral brightness is bounded on both sides. Each bound came from real
  feedback: too high was a harsh hiss, too low sounded like knocking on a door.

Game-simulation tests use a seeded PRNG. This is not fussiness: over 400 unseeded hands the same
code scored 368, 260 and 38 BB/100 on three different seeds — enough variance to flip the
conclusion between "crushing" and "roughly even".

## Trade-offs

- Play money only. Real stakes are a regulated, entirely different thing.
- Room codes are unguarded — anyone who guesses the code joins the table.
- Collusion is not preventable at the architecture level; it is an operations problem.
- Blinds do not escalate, so a session runs as a cash game rather than a tournament.
