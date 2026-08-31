# Known Issues — Pixel Atelier

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and a headless-Chrome boot/mode/crawl sweep.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 4109 assertions pass, 0 failed ("ALL TESTS PASSED") |
| `node --check` on all modules | clean (11 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — replaced by an ad-hoc CDP boot/mode/crawl sweep (see below) |

Ad-hoc headless-Chrome coverage: boot, all six title mode buttons, a round started via
`btn-setup-start` and driven through hint/undo/pause/resume/resize, a **journey stage completed**
and the ranked **Daily completed** (all 144 cells filled through the session's own
`select`/`fill` commands) to reach the results screen and a real score submission, a
70-click random UI crawl, and a corrupt-`localStorage` reload matrix (`{"broken":`, `null`, `[]`,
`{}`, non-JSON — all booted cleanly). Menu navigation is error-free; the two runtime faults below
(defects 3 and 4) only appear once a round actually finishes, which is why the crawl missed them.

## Confirmed defects

> **Fixed 2026-08-26.** All four defects below were fixed; `npm test` passes
> (4109 assertions, 0 failed) and `node --check` is clean on the changed files.

Defects below were each verified by reading the source, not just reported by the model.

### 1. Dead conditional in the spring integrator — both ternary branches are identical

**Fixed 2026-08-26:** `springStep` (`js/render.js`) now applies the standard
overshoot clamp: `if (change > 0 === out > target) { out = target; newVel = 0; }`.

- **File:** `js/render.js:25` (`springStep`)
- **Trigger:** Every animated cell height and camera move (`js/render.js:842`, `js/render.js:896`
  and other call sites) on every frame.
- **Behaviour:** The overshoot guard evaluates a condition and then returns the same expression
  either way:

  ```js
  const out = change + temp > 0 ? target + (change + temp) * exp : target + (change + temp) * exp;
  ```

  The `change + temp > 0` test has no effect at all. In the standard critically-damped spring this
  branch is where the result is clamped to `target` to stop the spring overshooting past its goal,
  so the clamp is effectively missing.
- **Expected:** Either clamp in one branch (the usual `if (originalTo - current > 0 === out > originalTo)
  { out = originalTo; ... }`) or delete the conditional.
- **Evidence:** The quoted line; found by an identical-branch scan over all eight games and
  confirmed by reading `js/render.js:17-27`.

### 2. Client requests `GET /api/v1/profile`, which the server does not route

**Fixed 2026-08-26:** the request was removed from `Platform.init()` in
`js/platform.js` — the bundled server only derives an opaque profile id and has no
display name to serve, so `this.profile` stays `null` and guests keep their local name.

- **File:** `js/platform.js:40`; route table in `server.js:131-268`
- **Trigger:** Every boot against the bundled server.
- **Behaviour:** `Platform.init()` does
  `try { this.profile = await this.get('/profile'); } catch { this.profile = null; }`, but
  `server.js` registers only `GET /time`, `GET /daily`, `GET /leaderboard`, `POST /scores`,
  `POST /achievements`, `GET /save`, `PUT /save`, `POST /presence`, `POST /activity` and
  `POST /telemetry`. The request 404s on every load, so `platform.profile` is always `null` and
  the host display name is never adopted at `js/main.js:99-100`; players stay "Guest" even when
  the host knows them.
- **Expected:** spec.md:192 — "Use the profile display name and avatar only where identity is
  useful". Either add the route or stop requesting it.
- **Evidence:** Headless-Chrome network log on a clean boot recorded
  `404 http://127.0.0.1:39504/api/v1/profile`, reproduced directly:

  ```
  $ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:39504/api/v1/profile
  404
  ```

### 3. Results screen throws every time — `$('board-mini')` looks up a class name, not an id

**Fixed 2026-08-26:** `js/ui.js` `renderResults` now looks up `$('results-board')`.

- **File:** `js/ui.js:334-335` (`UI.renderResults`), reached from `js/main.js:725`
  (`App.showResults`) via the completion timeout at `js/main.js:660`
- **Trigger:** Finish any round. Reproduced by completing a journey stage.
- **Behaviour:**

  ```js
  const bm = $('board-mini');
  bm.textContent = '';
  ```

  `index.html:98` declares `<div id="results-board" class="board-mini"></div>` — `board-mini` is the
  **class**, so `document.getElementById('board-mini')` is always `null` and line 335 throws.
  Everything after it in `renderResults` is skipped, so the board preview is never drawn and the
  Next button is never configured:

  ```js
  const next = $('btn-results-next');
  next.hidden = !canNext;              // js/ui.js:343 — never runs
  next.textContent = nextLabel || 'Next';
  ```

  The button therefore keeps its static markup and stays visible with the generic label even in
  modes that have no next stage.
- **Expected:** No exception; `results-board` cleared and populated; Next hidden/labelled per
  `canNext` / `nextLabel` (`js/main.js:710-722`).
- **Evidence:** Headless Chrome, completing a stage by applying all 144 correct fills through the
  session's own `fill()` API:

  ```
  STEP idcheck: {"byId_board_mini":false,"byId_results_board":true}
  STEP solve:   {"ok":144,"status":"complete"}
  STEP nextBtnState: {"hidden":false,"text":"Next","visible":true}
  --- console errors (1) ---
  EXCEPTION: TypeError: Cannot set properties of null (setting 'textContent')
      at UI.renderResults (…/js/ui.js:335:20)
      at App.showResults (…/js/main.js:725:13)
      at …/js/main.js:660:12
  ```

### 4. Cloud save is rejected by the server on every attempt — the request body is missing its `doc` wrapper

**Fixed 2026-08-26:** `cloudSave` in `js/platform.js` now PUTs `{ doc }`, matching the
server's required `body.doc` shape (and the read path's `remote?.doc` check).

- **File:** `js/platform.js:149-152` (`cloudSave`) vs `server.js:223-227` (`PUT /save`)
- **Trigger:** Finish a round, or run the "Sync cloud save" action, while hosted.
- **Behaviour:** `cloudSave` PUTs the wrapped save document itself —
  `this.put('/save', doc)` where `doc = wrap(this.data, this.rev)` = `{ v, rev, updatedAt, data, checksum }`
  (`js/storage.js:32-35`, `js/storage.js:141`). The server requires it nested:

  ```js
  if (!body?.doc?.data || !body.doc.checksum || typeof body.doc.rev !== 'number') {
    return err(res, 400, 'bad-save');
  }
  ```

  so `body.doc` is `undefined` and every save 400s. The read path already uses the nested shape
  (`js/main.js:1355`: `if (!remote?.doc) return;`), which shows the write side is the mistake.
  Progress is never uploaded; the failure is swallowed by `catch { return null; }`.
- **Expected:** spec.md:194 — "Cloud-save progression as a versioned, checksummed document."
- **Evidence:** Headless-Chrome network log after completing a round:
  `400 http://127.0.0.1:39504/api/v1/save`, alongside the client/server shapes quoted above.

## Suspected — not confirmed

### 1. `progressPct` is a non-integer stored in the result and used as the primary board key

- **File:** `js/rules.js:475`
- **Concern:** `progressPct: Math.round(progress(state) * 10000) / 100` yields values like
  `87.35`. It is stored in the score breakdown, persisted into board entries
  (`server.js:186`, `js/session.js:boardEntryFromSession`) and used as the first comparison key in
  `compareResults` (`js/rules.js:481`). spec.md:38 says "Store integers for score and simulation
  units; format values only in presentation."
- **Why unconfirmed:** A percentage is arguably a presentation value rather than a simulation
  unit, and no rounding artefact was observed in the passing golden tests.

### 2. `POST /scores` completion check passes when `verdict.result` is absent

- **File:** `server.js:173-175`
- **Concern:** `if (verdict.status !== 'complete' && verdict.result?.progressPct < 1)` — when
  `verdict.result` is `undefined` the comparison is `undefined < 1`, i.e. `false`, so an
  incomplete round would be accepted.
- **Why unconfirmed:** `Session.verify` appears always to return a `result` when `ok` is true
  (`js/session.js:133-166`), so no input reaching this line with a missing `result` could be
  constructed.

## Checked, no defects found

- Suspend/resume: entered a round, performed an action, reloaded the page, and confirmed the
  game re-boots with its snapshot intact and no console errors or failed requests.
- `js/rules.js` + `js/session.js`: legal actions, invalid reasons, error limit, move/time limits,
  itemised integer scoring, serialization round-trip and migration guard, `Session.verify` hash
  chain — the bundled suite covers all of these plus a malformed-command fuzz pass and four golden
  sessions, and the model review returned NO DEFECTS FOUND.
- `server.js` `POST /scores`: unlike several sibling games, this one takes **every** stored field
  from the authoritative `Session.verify` verdict (`score`, `progressPct`, `errors`, `elapsedMs`),
  applies an `implausible-speed` floor, and de-duplicates per profile. Live probes with a missing
  and a malformed envelope returned 422, not 500. Verified end-to-end by completing the ranked
  Daily in headless Chrome: solving through the session's own `select`/`fill` commands produced a
  replay whose hash chain validated server-side, and the submission was rejected only by the
  legitimate `implausible-speed` floor (144 cells solved in ~1 s against a `cells × 80 ms`
  minimum). Solving by mutating `state.selected` directly instead of issuing the `select` command
  correctly produced `replay-hash-mismatch` — the validation notices an unlogged state change.
- `js/storage.js`: `pixelatelier.save.v1`, `.session.v1` and `.boards.v1` survive five kinds of
  corruption without a boot failure (checksum + migration paths are also unit-tested).
- UI: 70 random clicks across title, setup, in-round HUD, tool rail, pause, results, boards,
  profile, settings and help produced zero console errors.
- Determinism: no `Math.random` in `js/rules.js`, `js/session.js` or `js/content.js`; the only
  uses are session/stroke ids, audio and 2-D decoration.

## QA side effects

- Running `server.js` during this pass created an untracked `data/` directory in the game root
  containing `presence.json`, `activity.json` and `achievements.json` (written by the
  `POST /presence`, `POST /activity` and `POST /achievements` routes the client calls on boot,
  while playing, and on unlock). No `saves.json` or `leaderboards.json` was written — the save
  write is rejected by defect 4, and the one ranked submission made was rejected by the server's
  `implausible-speed` floor before the write path. Left in place for central
  cleanup.

## Not tested

- `js/render.js` visual output beyond "boots and draws without errors": headless SwiftShader
  cannot judge the quality-tier or post-processing criteria in spec.md §4. The `springStep` defect
  above was found by reading, not by observation.
- Replay playback (`btn-results-replay`) and the animation skip path, which need a completed round.
- Touch, gamepad and pointer-drag painting.
