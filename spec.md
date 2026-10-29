# Pixel Atelier — Specification (StarHermit engine build)

**Status:** running specification of the shipped game.
**Runtime:** StarHermit engine script game, `engine.version=1.24.0`, `engine.minor=20` (host API 1.21), entry
`native/main.ts`. Played natively by the StarHermit client and in browsers by the engine's web runtime (the loader
`index.html` and `starhermit-files.json` written by `npm run package`).
**Players:** one; local casual boards per canvas, the platform's Score Chase leaderboard when signed in.

## 1. The game

Every cell of a pixel canvas hides a target color. The player picks a swatch from the palette and paints the cells
that want it — one cell at a time, in drag strokes, or with the region tool that floods a connected shape — until the
whole canvas is revealed as raised, glowing pixel art on a neon drafting table.

### Rules (js/rules.js, unchanged)
- Commands: start, pause, resume, select, fill (brush / drag stroke / region), undo, hint, tick, abandon. Every
  command is validated; rejections carry a reason (out of bounds, already finished, wrong color with error
  prevention, region color mismatch, color locked in sequence rulesets, undo disabled, …).
- Rulesets: error prevention on/off with an optional error limit, region tool on/off, undo on/off, move limit, time
  limit, colors in sequence.
- Terminal reasons: all cells filled (complete), move limit, time limit, error limit, abandoned.
- Score (integers): cells × 10, combo points (capped at 40 a fill), region bonus 15 a flood, completion 1000, a time
  bonus up to 500 under par; −25 an error, −15 a hint. Undo reverts a fill's own effects; hints and undos carry on.
- Journey stars: 1 for completing, +1 without errors, +1 within par time.
- The session (js/session.js) logs every command with ids, hashes the state every 10 commands, snapshots and restores
  by replaying the log, and builds replay envelopes; replays verify deterministically.

### Content (js/content.js, unchanged)
- 4 Learn lessons (Color & Fill, Drag-Fill, Region Tool, Navigate & Hint) with step goals.
- Journey: 42 stages in 7 chapters (authored arts and seeded "glimmerkin" creatures); every 6th stage is a mastery
  table with combined rules. Stages unlock in order; a chapter opens when the previous chapter's last stage has stars.
- Daily Table: one seed and twist (standard, speed, precision, sequence) per UTC day, from the platform's clock when
  it answered, else the device's.
- Practice: Calm / Standard / Expert presets with an optional inspectable seed (blank = random).
- Challenge: Speed Table, Precision Draft, Hand-Painted, Color Lock at levels I–III.
- Score Chase: one canvas per ISO week (platform clock), errors count.
- Themes (cosmetic): Neon Draft, Ember Grid (12 stages), Verdant Circuit (3-day streak), Mono Blueprint (10 stages),
  Rose Quartz (5,000 cells). Each sets the scene's colors and the ambience.
- Achievements (local, in the save): First Light, Mastery, Seven-Day Streak, Grand Atelier, Marathon Painter.

## 2. Screens and flow

Title → (Play: the Journey setup of the first stage without stars) or a mode → setup → a 3-2-1-Go countdown (input
locked) → the round (active ⇄ paused) → the completion wave → results (after 1.4 s; 0.15 s with reduced motion).

- **Title:** logo mark, the gradient wordmark, Play, cards for Daily Table (streak or today's best), Journey (stages
  done), Practice, Challenge, Score Chase, Learn (lessons done); Profile, Leaderboard, Settings, How to play, Invite a
  friend (signed in) and Sign in with StarHermit (signed out); the build / guest note. The drafting table shows
  through a light veil (every other menu screen uses a darker one).
- **Learn:** the lessons (✓ when done). **Journey:** the chapter map of stage cells (number or ★ for mastery,
  ●○○ stars, the name; locked cells dimmed).
- **Setup:** the canvas summary (size and colors, difficulty stars, expected time, ranked, limits, rules, seed) and a
  note; Practice adds the difficulty select and the seed field; Challenge the type and level selects; Daily the
  countdown to the next table.
- **Round HUD:** pause button, canvas title and mode; pills for the timer (or time left, amber under 15 s), moves
  left (amber near the end), errors (and the limit) and progress. Wide windows (≥ 1024 logical px) show the Objective
  rail (objective, progress bar, cells, combo, the lesson box) and the Tools rail (Brush, Region, Undo, Hint, zoom in,
  zoom out, Fit, Pan, with their keys); narrower windows put the rails in side drawers behind the ◧ / ◨ tabs (a press
  beside a drawer closes it) and show the lesson step in a strip under the top bar. The palette tray sits at the
  bottom centre: one swatch per color with its number, shape (● ◆ ■ ▲ ★ ✚ ◐ ⬟) and cells left; the chosen one ringed,
  finished ones faded, locked ones (sequence rulesets) greyed. On short landscape windows (≤ 500 px tall) the tray is a
  column at the right (the left with the left-handed layout).
- **Pause card:** summary, Resume, Settings, Skip animations, Restart round (confirmed), Leave round (confirmed).
- **Results:** headline by reason, stars (Journey), the score breakdown, the progress line, new achievement badges, the
  local board rank, the Score Chase leaderboard line, the seed; Next stage / Next lesson, Retry (same seed), Watch
  replay (the round's commands replayed at 90 ms each, Esc ends it), Leaderboard, Home.
- **Profile:** display name, sign-in state and cloud sync line, lifetime stats, achievements with dates, local rivals
  (add / remove; a rival's best follows the scores recorded under that name), Sync cloud save (signed in).
- **Leaderboard:** this week's Score Chase board or the last round's board; Global / Friends (rivals and you). Signed
  in, the platform's board (read-only, nicknames); otherwise the local casual board (best 50 per canvas).
- **Settings:** the game's options (below), a button for the runtime's Options and one for key bindings, the theme
  swatches (locked ones say how they unlock), Replay tutorials and Erase local data (confirmed).
- **How to play:** eight cards (goal, painting with the current key bindings, region tool, camera, hints & undo,
  rulesets, scoring, access).
- Toasts (2.6 s), captions for audio cues (2.2 s, an option), the countdown, screen-reader announcements for rounds,
  lesson steps, errors, cursor cells and results.
- Returning players: an unfinished round's snapshot (saved every 4 s while dirty, on pause and when hidden) is offered
  on start ("Welcome back"); resuming replays it and opens the pause card.

## 3. Controls

Actions are declared in `starhermit.txt` (players rebind keys and pads in the runtime's Options):

| Action | Keys | Pad |
| --- | --- | --- |
| Paint at the cursor | Enter, Numpad Enter | South |
| Cursor up / down / left / right | Arrows, WASD | D-pad |
| Next / previous color | E / Q | Right / left shoulder |
| Swatch 0–8 | Digits, numpad digits | — |
| Region tool / brush | R / B | — |
| Undo / hint | U / H | West / North |
| Refit camera | C | Select |
| Zoom in / out | = / − (numpad + / −) | Right / left trigger |
| Pan | I J K L | Left stick |
| Pause | P | Start, East |
| Cancel (closes the pause card, a drawer, menus) | Escape | — |

- The first cursor key puts the keyboard cursor on a cell that wants the selected color; Enter paints there with the
  current tool. Enter on a focused button presses the button.
- Pointer: press or drag across cells with the brush (strokes interpolate between cells; a tap that missed at the
  press is retried at the release), press a shape with the region tool (hovering previews the flood), wheel zooms,
  right or middle drag pans, Pan mode makes a left drag pan. Hovering a cell shows its color box and ring.
- Touch: one finger paints like the mouse; two fingers pinch-zoom and pan (and end a stroke).
- Hold to paint (option, default on): off, a press starts a stroke that pointer movement keeps painting until the next
  press.
- Presses over the HUD (bars, rails, tray, drawers, toasts) belong to the HUD; a press that closes a card never paints.

## 4. Settings and the runtime

- The runtime's Options own volumes and mute, graphics level, frame-rate limit, language, larger text (UI scale),
  high contrast (the game switches to its high-contrast token set) and reduced motion (no reveal, springs, shake or
  ambient motion; shorter results delay and replay steps).
- The game's options are engine settings (device and account): cell palette (artwork, vivid contrast, color-vision
  safe), always show cell numbers (they also show at close zoom), captions for audio cues, haptics, left-handed layout
  (swaps the rails; the landscape tray goes to the start side), hold to paint, timing assistance (+50 % on time limits,
  recorded as an assist).

## 5. Look and sound

- `starhermit:scene`: perspective camera (FOV 32°) over the table at a 0.76 rad elevation, a critically damped spring
  for pan / zoom / refit, a low shake on errors and completion. Lights from three.js r170 ÷ π (hemisphere 0.55, key
  1.6, pink rim point light 60). ACES tone mapping at 1.12, fog 30–95.
- Per quality tier (`frame().quality`, budgets scaled up to 2× by `frame().levelIndex`):

  | Tier | Shadows | AO | Bloom | Grade | AA | Reflections | Cells | Extras |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Low | off | off | off | off | MSAA | off | Lambert | plain grid, ≤ 96 sparks |
  | Balanced | 1024 | off | on | on | FXAA | on | Standard | detailed table, pylons, ring, 32 floaters, dust |
  | High | 2048 | on | on | on | SMAA | on | clear-coated Physical | 44 floaters |
  | Ultra | 4096 | high | on | on | MSAA | on | clear-coated Physical | 72 floaters, full-res bloom/AO |

  Bloom 0.6 / 0.5 / threshold 0.9 (only the neon strips, frame, pylon tips and fill pulses exceed 1); GTAO radius 0.5;
  the display-space grade (S-curve, saturation 1.12, cool shadows / warm highlights, 0.26 vignette); the room
  environment at 0.22.
- `starhermit:ui` styles come from `tools/ui-style.css` → `assets/ui-style.json` (`npm run css`).
- `starhermit:audio`: the 17 authored one-shots in `sfx/`; the theme's ambience (filtered noise with an LFO, 20 s loop)
  and the seeded pad music (8 chords) rendered into clips at start, looped on the music bus; the pluck layer fades in
  past 35 % progress at the progress level.

## 6. Platform integration

- **Save:** `saves` schema 1 `{ v, data }` (js/progress.js): profile, journey stars and bests, achievements, daily
  streak and history, lifetime stats, tutorials done, theme and unlocks, rivals. Two devices' saves merge (best of
  both). The browser build's cloud slot (`game:<slug>`, a checksummed `{ v, rev, updatedAt, data }`) shows as a foreign
  save: its progress is merged and its a11y options adopted, then it is replaced once. Its settings KV keys (audio,
  graphics, a11y, camera, ui.*) are read once (a11y options adopted) and removed.
- **Device only** (`storage`): the round snapshot and the local boards (as localStorage held them).
- **Leaderboard:** a finished Score Chase round (not abandoned), signed in, posts its total through `score-script.js`
  (a practice session; the script range-checks it onto the `high-score` board) and shows the rank. Other modes stay on
  the local casual boards, as before.
- Invite link (copied to the clipboard), sign-in, sign-out notice, the platform clock for Daily and the week.
- Language from `preferences().language` over js/strings.js (nine locales); account strings in js/platform-i18n.js.

## 7. Files

- `native/`: main.ts (state machine, rounds, input, clock), screens.ts (UI), render.ts (scene), audio.ts, platform.ts,
  quality.ts, style.ts, i18n.ts, game.ts (typed facade).
- `js/`: rules.js, content.js, session.js, rng.js, progress.js, i18n.js, strings.js, platform-i18n.js.
- `assets/`: ui-style.json, table-rough.png (`tools/bake-rough.mjs`). `sfx/`: the one-shots.
- `score-script.js`: the leaderboard script (server=).

## 8. Checks

- `npm test`: rules/content/replay acceptance tests (tests/run.mjs), the save model (tests/progress.test.mjs), every
  used string in all locales (tests/i18n.test.mjs), then tests/native.mjs: the web index up to date, `tsc`, `starhermit
  check` with no warnings, and the play scripts in `tests/native/` as render checks — Journey stage 1 solved by keys
  (desktop), the four lessons by finger (phone, DPR 3), the menus, settings, profile, setups and a Practice round's pause
  / restart / leave (desktop), and Score Chase on a short landscape phone. `npm run plays` regenerates the first two
  from the rules (tools/gen-plays.mjs, tools/plans.mjs).
- `npm run test:browser` (tools/browser-play.mjs): the packaged game in GPU Chrome at desktop, phone and landscape —
  Journey 1 by keys with pause, lesson 1 by finger, a Score Chase finger stroke, pause and leave; fails on console
  errors or warnings.

## 9. Port differences and known limitations

- The 2D compatibility renderer (no WebGL) is gone: the engine always draws the scene; Low is the light tier.
- The old Graphics panel's per-effect overrides, render scale and FPS meter are the runtime's Options now.
- Menus over the table use a plain veil (the old backdrop blur is not drawn).
- The grade's black lift (×0.975 + 0.018) has no equivalent in the runtime's display grade and is left out.
- Ambience LFO rates are rounded to whole cycles of the 20 s loop; music and ambience are pre-rendered clips; the
  synthesized fallbacks for sounds still loading are not played.
- Local boards keep entries without their replay envelopes (nothing read them back).
- Action ids are lowercase now (`next_color`, `cam_reset`, …): key rebindings saved by the browser build are not
  carried over. Guests' browser localStorage progress cannot migrate (signed-in cloud saves do).
- Hold to paint off (toggle) was a stored but unused option in the browser build; it works now.
- Erase local data resets the progress, the round snapshot, the local boards and the game's options on this device
  (the account's copy of the progress follows the next save).
