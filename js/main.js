// main.js — bootstrap + orchestration: state machine, input (pointer, touch,
// keyboard, gamepad), session lifecycle, persistence, achievements, boards.
// boot → title → mode-select → preparing → countdown → active ↔ paused
//     → resolving → results → progression

import * as rules from './rules.js';
import {
  JOURNEY, JOURNEY_CHAPTERS, LESSONS, THEMES, CHALLENGE_TYPES, PRACTICE_PRESETS,
  lessonContent, dailyContent, practiceContent, challengeContent, scoreChaseContent,
  remapPalette, getTheme, validateAllShipped, difficultyOf,
} from './content.js';
import { Session, boardEntryFromSession, compareBoardEntries, boardIdFor, BUILD_VERSION } from './session.js';
import { SaveStore } from './storage.js';
import { Platform } from './platform.js';
import { AudioEngine } from './audio.js';
import { UI, $, fmtTime } from './ui.js';

// ---------------------------------------------------------------------------
// Achievements — static set, stable lowercase keys, idempotent unlocks.
// ---------------------------------------------------------------------------
const ACHIEVEMENTS = [
  { key: 'first-completion', name: 'First Light', desc: 'Complete your first canvas.' },
  { key: 'mechanic-mastery', name: 'Mastery', desc: 'Complete a journey mastery stage.' },
  { key: 'daily-streak-7', name: 'Seven-Day Streak', desc: 'Complete dailies on 7 consecutive days.' },
  { key: 'expert-milestone', name: 'Grand Atelier', desc: 'Complete the final journey stage.' },
  { key: 'marathon-painter', name: 'Marathon Painter', desc: 'Paint 10,000 cells in total.' },
];

const DEFAULT_BINDINGS = [
  { id: 'fill', label: 'Paint / confirm', def: 'Enter' },
  { id: 'cancel', label: 'Cancel', def: 'Escape' },
  { id: 'pause', label: 'Pause', def: 'p' },
  { id: 'undo', label: 'Undo', def: 'u' },
  { id: 'hint', label: 'Hint', def: 'h' },
  { id: 'nextColor', label: 'Next color', def: 'e' },
  { id: 'prevColor', label: 'Previous color', def: 'q' },
  { id: 'regionTool', label: 'Region tool', def: 'r' },
  { id: 'brushTool', label: 'Brush tool', def: 'b' },
  { id: 'camReset', label: 'Reset camera', def: 'c' },
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
class App {
  constructor() {
    this.ui = new UI();
    this.store = new SaveStore();
    this.platform = new Platform();
    this.audio = new AudioEngine();
    this.renderer = null;
    this.session = null;
    this.content = null;
    this.mode = null;               // learn | journey | daily | practice | challenge | score-chase
    this.lesson = null;             // active lesson runtime
    this.lessonStep = 0;
    this.appState = 'boot';
    this.tool = 'brush';
    this.panMode = false;
    this.stroke = null;             // active drag stroke {id, cells}
    this.pointers = new Map();      // active pointer tracking (pinch)
    this.keyboardCell = -1;
    this.hoverCell = -1;
    this.replayMode = false;
    this._tickAcc = 0;
    this._lastFrame = 0;
    this._frameAvg = 16;
    this._renderScale = 1;
    this._autosaveT = 0;
    this._pendingSetup = null;
    this._lastContent = null;       // for retry
    this._awayNote = '';
    this._gamepad = { buttons: [], axes: [0, 0], repeatAt: 0 };
  }

  // ---------------------------------------------------------------- boot ---
  async boot() {
    this.ui.init(this._handlers());
    this.audio.onCaption = (t) => {
      if (this.store.data.settings.a11y.captions) this.ui.caption(t);
    };
    this.audio.hapticsEnabled = this.store.data.settings.a11y.haptics;

    this.ui.setBoot(0.1, 'Checking capabilities…');
    const force2d = typeof location !== 'undefined' && new URLSearchParams(location.search).has('force2d');
    const webgl = detectWebGL() && !force2d;
    if (!webgl) {
      this.ui.showCompatNote('WebGL is unavailable — using the 2D compatibility renderer. All modes remain playable.');
    }

    this.ui.setBoot(0.25, 'Loading save…');
    this.applySettingsToDom();

    this.ui.setBoot(0.4, 'Contacting host…');
    await this.platform.init();
    this.platform.setTelemetryConsent(this.store.data.settings.telemetryConsent);
    if (this.platform.hosted) {
      this.platform.activityStart();
      if (this.platform.profile?.name && this.store.data.profile.guest) {
        this.store.update((d) => { d.profile.name = this.platform.profile.name; });
      }
      await this.syncCloudSave();
    }

    this.ui.setBoot(0.6, 'Validating content…');
    await frame();
    const problems = validateAllShipped();
    if (problems.length) console.error('content validation failed:', problems);

    this.ui.setBoot(0.75, 'Building the drafting table…');
    await frame();
    this.createRenderer(webgl);
    this.applyTheme();
    this.applyQuality();

    this.ui.setBoot(0.9, 'Syncing daily table…');
    await this.refreshDailyCard();

    this.bindInput();
    this.ui.setBoot(1, 'Ready');
    this.platform.track('start', { mode: 'boot' });

    // Returning player: resume offers the last safe snapshot within 2 actions.
    const snapshot = this.store.loadSessionSnapshot();
    this.toTitle();
    if (snapshot && snapshot.log?.length) {
      const away = Date.now() - (snapshot.savedAt || Date.now());
      const yes = await this.ui.confirm(
        `You have an unfinished round (${snapshot.content.meta?.title || snapshot.content.id})` +
        (away > 60000 ? ` — paused ${fmtTime(away)} ago.` : '.') + ' Resume it?',
        'Welcome back'
      );
      if (yes) this.resumeSnapshot(snapshot);
      else this.store.clearSessionSnapshot();
    }
  }

  createRenderer(webgl) {
    const canvas3d = $('gl');
    const canvas2d = $('flat');
    if (webgl) {
      import('./render.js').then(({ createRenderer3D }) => {
        if (this.renderer) return;
        this.renderer = createRenderer3D(canvas3d, {});
        this.renderer.onCameraChange = () => this.noteCameraMove();
        if (this.content) {
          this.renderer.setTheme(getTheme(this.store.data.cosmetics.theme));
          this.renderer.setBoard(this.content, this.resolvedPalette());
          if (this.session) this.renderer.syncState(this.session.state);
        }
        this.applyQuality();
        this.applyA11yToRenderer();
      }).catch((err) => {
        console.error('3D renderer failed, falling back to 2D', err);
        canvas3d.hidden = true;
        canvas2d.hidden = false;
        import('./render2d.js').then(({ createRenderer2D }) => {
          this.renderer = createRenderer2D(canvas2d, {});
          this.renderer.onCameraChange = () => this.noteCameraMove();
          this.applyTheme();
        });
      });
    } else {
      canvas3d.hidden = true;
      canvas2d.hidden = false;
      import('./render2d.js').then(({ createRenderer2D }) => {
        this.renderer = createRenderer2D(canvas2d, {});
        this.renderer.onCameraChange = () => this.noteCameraMove();
        this.applyTheme();
      });
    }
  }

  resolvedPalette() {
    return remapPalette(this.content?.palette || [], this.store.data.settings.a11y.palette);
  }

  // ------------------------------------------------------- state machine ---
  toTitle() {
    this.appState = 'title';
    clearInterval(this._dailyCdT);
    this.teardownSession(false);
    this.ui.showHUD(false);
    this.ui.showScreen('title');
    this.refreshTitleCard();
    this.audio.play('ui.open');
  }

  refreshTitleCard() {
    const d = this.store.data;
    const done = Object.keys(d.journey.stars || {}).length;
    $('journey-sub').textContent = `${done} / ${JOURNEY.length} stages`;
    $('learn-sub').textContent = `${d.tutorials.done.length} / ${LESSONS.length} done`;
    $('title-note').textContent = this.platform.hosted
      ? `Signed in · build ${BUILD_VERSION}`
      : `Guest mode · build ${BUILD_VERSION} · progress saved locally`;
  }

  async refreshDailyCard() {
    const info = await this.platform.dailyInfo();
    const today = this.platform.utcDateString();
    const doneToday = this.store.data.daily.history?.[info.date || today];
    $('daily-sub').textContent = doneToday
      ? `Done today · best ${doneToday.score}`
      : `Streak ${this.store.data.daily.streak} · new canvas`;
  }

  // --- mode selection / setup ---
  openMode(mode) {
    this.mode = mode;
    if (mode === 'learn') {
      this.ui.renderLessons(LESSONS, this.store.data.tutorials.done, (lesson) => this.startLesson(lesson));
      this.ui.showScreen('learn');
      this.appState = 'mode-select';
      return;
    }
    if (mode === 'journey') {
      this.ui.renderJourney(JOURNEY_CHAPTERS, JOURNEY, this.store.data, (stage) => this.showSetup('journey', stage));
      this.ui.showScreen('journey');
      this.appState = 'mode-select';
      return;
    }
    this.showSetup(mode, null);
  }

  async showSetup(mode, preset) {
    this.appState = 'mode-select';
    const body = $('setup-body');
    body.textContent = '';
    const desc = document.createElement('div');
    let startLabel = 'Start';
    const assist = this.store.data.settings.a11y.timingAssist;

    const addRulesSummary = (content, extra = '') => {
      const r = content.ruleset;
      const rows = [
        ['Canvas', `${content.width}×${content.height} · ${content.palette.length} colors`],
        ['Difficulty', '★'.repeat(difficultyOf(content))],
        ['Expected', fmtTime(content.par.timeMs)],
        ['Ranked', content.meta.ranked ? 'Yes — validated board' : 'No'],
      ];
      if (r.moveLimit != null) rows.push(['Move limit', `${r.moveLimit} actions`]);
      if (r.timeLimitMs != null) rows.push(['Time limit', fmtTime(assist ? r.timeLimitMs * 1.5 : r.timeLimitMs) + (assist ? ' (assist)' : '')]);
      if (!r.errorPrevention) rows.push(['Errors', `Count against you${r.errorLimit ? ` · fail at ${r.errorLimit}` : ''}`]);
      if (!r.tools.region) rows.push(['Tools', 'Region tool disabled']);
      if (r.sequence) rows.push(['Order', 'Colors unlock in sequence']);
      rows.push(['Seed', content.seed]);
      const dl = document.createElement('dl');
      dl.className = 'stat-list';
      for (const [k, v] of rows) {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        dl.append(dt, dd);
      }
      desc.appendChild(dl);
      if (extra) {
        const p = document.createElement('p');
        p.className = 'dim';
        p.textContent = extra;
        desc.appendChild(p);
      }
    };

    if (mode === 'journey' && preset) {
      $('setup-h').textContent = preset.meta.title;
      addRulesSummary(preset, preset.meta.mastery ? 'Mastery table — combined mechanics.' : 'Journey stage.');
      this._pendingSetup = { mode, content: preset };
    } else if (mode === 'daily') {
      $('setup-h').textContent = 'Daily Table';
      const info = await this.platform.dailyInfo();
      const content = dailyContent(info.date);
      this._dailyExcluded = info.excluded === true;
      addRulesSummary(content,
        this._dailyExcluded ? 'This day was excluded from ranking due to a content issue.' : 'One shared seed per UTC day.');
      const cd = document.createElement('p');
      cd.className = 'dim';
      desc.appendChild(cd);
      const tickCd = () => { cd.textContent = `Next table in ${fmtTime(this.platform.msUntilNextUtcDay())} (platform time).`; };
      tickCd();
      clearInterval(this._dailyCdT);
      this._dailyCdT = setInterval(() => {
        if (document.getElementById('app').dataset.screen !== 'setup') clearInterval(this._dailyCdT);
        else tickCd();
      }, 1000);
      this._pendingSetup = { mode, content };
      startLabel = 'Start daily';
    } else if (mode === 'practice') {
      $('setup-h').textContent = 'Practice';
      const sel = document.createElement('select');
      sel.id = 'practice-preset';
      sel.className = 'field';
      for (const [id, p] of Object.entries(PRACTICE_PRESETS)) {
        const o = document.createElement('option');
        o.value = id; o.textContent = `${p.label} — ${p.blurb}`;
        sel.appendChild(o);
      }
      sel.value = 'standard';
      const seedInput = document.createElement('input');
      seedInput.type = 'text'; seedInput.placeholder = 'Seed (blank = random)'; seedInput.maxLength = 40;
      seedInput.setAttribute('aria-label', 'Practice seed');
      const wrap = document.createElement('div');
      wrap.innerHTML = '<p class="dim">Unranked. Restart and undo freely — nothing here affects ratings.</p>';
      const lf = document.createElement('label'); lf.className = 'field'; lf.textContent = 'Difficulty'; lf.appendChild(sel);
      const ls = document.createElement('label'); ls.className = 'field'; ls.textContent = 'Seed (inspectable)'; ls.appendChild(seedInput);
      wrap.append(lf, ls);
      desc.appendChild(wrap);
      this._pendingSetup = { mode, make: () => practiceContent(sel.value, seedInput.value.trim() || undefined) };
    } else if (mode === 'challenge') {
      $('setup-h').textContent = 'Challenge';
      const sel = document.createElement('select');
      for (const [id, c] of Object.entries(CHALLENGE_TYPES)) {
        const o = document.createElement('option');
        o.value = id; o.textContent = `${c.label} — ${c.blurb}`;
        sel.appendChild(o);
      }
      const lvl = document.createElement('select');
      for (const [v, l] of [[1, 'I — small'], [2, 'II — medium'], [3, 'III — large']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = l; lvl.appendChild(o);
      }
      lvl.value = 2;
      const wrap = document.createElement('div');
      const lf = document.createElement('label'); lf.className = 'field'; lf.textContent = 'Challenge'; lf.appendChild(sel);
      const ll = document.createElement('label'); ll.className = 'field'; ll.textContent = 'Level'; ll.appendChild(lvl);
      wrap.append(lf, ll);
      desc.appendChild(wrap);
      this._pendingSetup = { mode, make: () => challengeContent(sel.value, Number(lvl.value)) };
    } else if (mode === 'score-chase') {
      $('setup-h').textContent = 'Score Chase';
      const week = this.platform.isoWeekString();
      const content = scoreChaseContent(week);
      addRulesSummary(content, 'Same seed for everyone this week. Highest validated total wins.');
      this._pendingSetup = { mode, content };
      startLabel = 'Start chase';
    }

    body.appendChild(desc);
    $('btn-setup-start').textContent = startLabel;
    this.ui.showScreen('setup');
  }

  // --- round lifecycle ---
  startSetup() {
    const setup = this._pendingSetup;
    if (!setup) return;
    const content = setup.content || setup.make?.();
    if (content) this.startRound(content, setup.mode);
  }

  startRound(content, mode) {
    // Timing assist is declared up-front and recorded as an assist.
    if (this.store.data.settings.a11y.timingAssist && content.ruleset.timeLimitMs) {
      content = JSON.parse(JSON.stringify(content));
      content.ruleset.timeLimitMs = Math.round(content.ruleset.timeLimitMs * 1.5);
      content.meta.assists = ['timing'];
    }
    this.teardownSession(false);
    this.content = content;
    this.mode = mode;
    this._lastContent = content;
    this.appState = 'preparing';
    this.tool = 'brush';
    this.stroke = null;
    this.keyboardCell = -1;
    this.replayMode = false;

    this.session = new Session(content, {
      onEvents: (events, state) => this.onSessionEvents(events, state),
      onState: () => this.autosaveSoon(),
    });

    if (this.renderer) {
      this.renderer.setTheme(getTheme(this.store.data.cosmetics.theme));
      this.renderer.setBoard(content, this.resolvedPalette());
      this.renderer.syncState(this.session.state);
      this.renderer.setTool?.(this.tool);
    }
    this.ui.showScreen(null);
    this.ui.showHUD(true);
    this.ui.syncLayout();
    this.ui.setHudInfo(content.meta.title, mode.replace('-', ' '));
    this.ui.setObjective(this.objectiveText(content));
    this.ui.setTool(this.tool, content.ruleset.tools);
    this.refreshHud(true);
    this.updatePalette();
    this.ui.announce(`${content.meta.title}. ${this.objectiveText(content)}`);

    // Countdown — input locked during this shortest resolution phase.
    this.appState = 'countdown';
    let n = 3;
    this.ui.countdown(String(n));
    this.audio.ensure();
    this.audio.play('ui.tap');
    const step = () => {
      n--;
      if (n > 0) {
        this.ui.countdown(String(n));
        this.audio.play('ui.tap');
        this._cdT = setTimeout(step, 700);
      } else {
        this.ui.countdown('Go!');
        this.audio.play('resume');
        this._cdT = setTimeout(() => {
          this.ui.countdown(null);
          this.session.start();
          this.appState = 'active';
          this.platform.startPresence();
          this.audio.startAmbience(getTheme(this.store.data.cosmetics.theme).ambience);
          if (!this.audio._music) this.audio.startMusic(content.seed);
          this.refreshHud(true);
        }, 500);
      }
    };
    this._cdT = setTimeout(step, 700);
  }

  objectiveText(content) {
    const r = content.ruleset;
    if (r.sequence) return 'Fill colors in order — the palette shows which is active.';
    if (r.moveLimit != null) return `Fill every cell within ${r.moveLimit} actions.`;
    if (r.timeLimitMs != null) return `Fill every cell before time runs out.`;
    if (r.errorLimit != null) return `Fill every cell. ${r.errorLimit} wrong cells end the round.`;
    return 'Fill every cell with its target color.';
  }

  startLesson(lesson) {
    const { content } = lessonContent(lesson.id);
    this.startRound(content, 'learn');
    // Set after startRound — teardownSession clears lesson state.
    this.lesson = { def: lesson, fills: 0, strokeCells: new Map(), maxStroke: 0, cameraMoved: false, hinted: false };
    this.lessonStep = 0;
    this.ui.setLesson(lesson.title, lesson.intro);
    this.ui.announce(`Lesson: ${lesson.title}. ${lesson.intro}`, true);
    this._lessonStarted = false;
  }

  advanceLesson() {
    const L = this.lesson;
    if (!L) return;
    const step = L.def.steps[this.lessonStep];
    if (step) {
      this.ui.setLesson(L.def.title, `Step ${this.lessonStep + 1}/${L.def.steps.length}: ${step.text}`);
      this.ui.announce(step.text);
    }
  }

  checkLessonEvents(events) {
    const L = this.lesson;
    if (!L) return;
    if (!this._lessonStarted) {
      this._lessonStarted = true;
      this.advanceLesson();
    }
    const step = L.def.steps[this.lessonStep];
    if (!step) return;
    let done = false;
    for (const ev of events) {
      const req = step.require;
      if (req.type === 'select' && ev.type === 'select' && ev.color === req.color) done = true;
      if (req.type === 'fills' && ev.type === 'fill') {
        L.fills += ev.cells.length;
        if (L.fills >= req.n) done = true;
      }
      if (req.type === 'stroke' && ev.type === 'fill' && ev.tool === 'drag') {
        // stroke length tracked in onSessionEvents via stroke map
      }
      if (req.type === 'region' && ev.type === 'fill' && ev.tool === 'region') done = true;
      if (req.type === 'camera' && L.cameraMoved) done = true;
      if (req.type === 'hint' && ev.type === 'hint') done = true;
      if (req.type === 'complete' && ev.type === 'terminal' && ev.status === 'complete') done = true;
    }
    if (step.require.type === 'stroke' && L.maxStroke >= (step.require.minCells || 4)) done = true;
    if (step.require.type === 'camera' && L.cameraMoved) done = true;
    if (done) {
      this.audio.play('lesson.step');
      this.lessonStep++;
      if (this.lessonStep < L.def.steps.length) this.advanceLesson();
      else this.ui.setLesson(L.def.title, 'Lesson complete!');
    }
  }

  noteCameraMove() {
    if (this.lesson) {
      this.lesson.cameraMoved = true;
      this.checkLessonEvents([]);
    }
  }

  // --- session events → render/audio/hud ---
  onSessionEvents(events, state) {
    this.renderer?.applyEvents(events, state);
    for (const ev of events) {
      switch (ev.type) {
        case 'fill': {
          const variant = (ev.cells[0] % 100) / 100;
          this.audio.play(ev.tool === 'region' ? 'fill.region' : ev.tool === 'drag' ? 'fill.drag' : 'fill.brush', { variant });
          if (ev.combo > 0 && ev.combo % 5 === 0) this.audio.play('combo', { tier: ev.combo / 5, combo: ev.combo });
          this.ui.setCombo(ev.combo);
          if (this.lesson && this.stroke) {
            const n = (this.lesson.strokeCells.get(this.stroke.id) || 0) + ev.cells.length;
            this.lesson.strokeCells.set(this.stroke.id, n);
            this.lesson.maxStroke = Math.max(this.lesson.maxStroke || 0, n);
          }
          break;
        }
        case 'error':
          this.audio.play('error');
          this.ui.setCombo(0);
          this.ui.announce(`Wrong color — target was ${ev.target}.`, true);
          break;
        case 'invalid': {
          // Mid-stroke rejections (filled/wrong cells under a drag) are
          // expected — acknowledge the stroke start, stay quiet after.
          const quiet = ev.cmd && ev.cmd.strokeContinuation;
          if (!quiet) {
            this.audio.play('invalid');
            if (ev.message) {
              this.ui.toast(ev.message);
              this.ui.announce(ev.message, true);
            }
          }
          break;
        }
        case 'select': this.audio.play('select'); this.updatePalette(); break;
        case 'undo': this.audio.play('undo'); this.updatePalette(); break;
        case 'hint': {
          this.audio.play('hint');
          if (ev.hint?.type === 'fill') {
            this.ui.toast(`Try ${ev.hint.tool === 'region' ? 'the region tool on' : 'painting'} the highlighted cell.`);
            this.flashHint(ev.hint.cell, ev.hint.tool === 'region');
          } else if (ev.hint?.type === 'select') {
            this.ui.toast(`This color is finished — switch to color ${ev.hint.color === 0 ? '•' : ev.hint.color}.`);
          }
          break;
        }
        case 'pause': this.audio.play('pause'); break;
        case 'resume': this.audio.play('resume'); break;
        case 'terminal': this.onTerminal(ev); break;
      }
    }
    if (this.lesson) this.checkLessonEvents(events);
    this.refreshHud();
  }

  flashHint(cell, isRegion) {
    if (!this.renderer || !this.session) return;
    const cells = isRegion ? rules.regionAt(this.session.state, cell) : [cell];
    this.renderer.setGhost(cells);
    setTimeout(() => this.renderer?.setGhost(null), 1800);
  }

  refreshHud(force = false) {
    const s = this.session?.state;
    if (!s) return;
    const total = s.w * s.h;
    this.ui.setProgress(s.stats.correct, total);
    const r = s.ruleset;
    this.ui.setMoves(r.moveLimit != null ? `${Math.max(0, r.moveLimit - s.stats.actions)}` : '', r.moveLimit != null,
      r.moveLimit != null && r.moveLimit - s.stats.actions <= Math.ceil(total * 0.08));
    this.ui.setErrors(!r.errorPrevention || r.errorLimit != null ? `${s.stats.errors}${r.errorLimit ? `/${r.errorLimit}` : ''}` : '',
      !r.errorPrevention || r.errorLimit != null);
    const la = rules.legalActions(s);
    this.ui.setActionStates({ canUndo: la.canUndo, canHint: la.canHint });
    if (force) this.updatePalette();
  }

  updatePalette() {
    const s = this.session?.state;
    if (!s) return;
    const remaining = {}, totals = {};
    for (let i = 0; i < s.targets.length; i++) {
      const t = s.targets[i];
      totals[t] = (totals[t] || 0) + 1;
      if (!s.filled[i]) remaining[t] = (remaining[t] || 0) + 1;
    }
    this.ui.renderPalette(this.resolvedPalette(), s.selected, remaining, totals,
      { lockedColor: s.ruleset.sequence ? s.seqColor : null });
  }

  // --- terminal / results ---
  onTerminal(ev) {
    this.appState = 'resolving';
    this.platform.stopPresence();
    this.store.clearSessionSnapshot();
    const state = this.session.state;
    const final = ev.final;
    const complete = ev.status === 'complete';

    // Persist stats + progression.
    const unlockedAch = [];
    this.store.update((d) => {
      d.stats.cellsFilled += state.stats.correct;
      d.stats.playtimeMs += state.elapsedMs;
      if (complete) d.stats.roundsCompleted++;
      if (this.lesson && complete) {
        if (!d.tutorials.done.includes(this.lesson.def.id)) d.tutorials.done.push(this.lesson.def.id);
        this.platform.track('tutorial-step', { step: this.lesson.def.id });
      }
      if (this.mode === 'journey' && complete) {
        const stars = this.starsFor(state);
        d.journey.stars[this.content.id] = Math.max(d.journey.stars[this.content.id] || 0, stars);
        d.journey.bestScores[this.content.id] = Math.max(d.journey.bestScores[this.content.id] || 0, final.total);
      }
      if (this.mode === 'daily' && complete) {
        const date = this.content.id.replace('daily-', '');
        const prev = d.daily.history[date];
        d.daily.history[date] = { score: Math.max(prev?.score || 0, final.total) };
        const today = date;
        const y = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) - 1));
        const yesterday = y.toISOString().slice(0, 10);
        if (d.daily.lastDate === today) { /* already counted */ }
        else if (d.daily.lastDate === yesterday) { d.daily.streak += 1; d.daily.lastDate = today; }
        else { d.daily.streak = 1; d.daily.lastDate = today; }
      }
      // Achievements (idempotent).
      const grant = (key) => {
        if (!d.achievements[key]) {
          d.achievements[key] = Date.now();
          unlockedAch.push(ACHIEVEMENTS.find((a) => a.key === key));
          this.platform.unlockAchievement(key);
        }
      };
      if (complete) grant('first-completion');
      if (complete && this.content.meta.mastery) grant('mechanic-mastery');
      if (d.daily.streak >= 7) grant('daily-streak-7');
      if (complete && this.content.id === 'j42') grant('expert-milestone');
      if (d.stats.cellsFilled >= 10000) grant('marathon-painter');
      // Cosmetic unlocks.
      const stageCount = Object.keys(d.journey.stars).length;
      const unlocks = [
        ['ember-grid', stageCount >= 12],
        ['verdant-circuit', d.daily.streak >= 3],
        ['mono-blueprint', stageCount >= 10],
        ['rose-quartz', d.stats.cellsFilled >= 5000],
      ];
      for (const [id, ok] of unlocks) {
        if (ok && !d.cosmetics.unlocked.includes(id)) {
          d.cosmetics.unlocked.push(id);
          this.ui.toast(`Theme unlocked: ${getTheme(id).name}`);
        }
      }
    });

    this.audio.play(complete ? 'complete' : 'failed');
    this.audio.setMusicIntensity(0);
    this.platform.track('round-end', { mode: this.mode, outcome: ev.status });
    if (this.platform.hosted) this.platform.cloudSave(this.store.exportDoc());

    // Leaderboards.
    const entry = boardEntryFromSession(this.session, this.store.data.profile.name);
    const boardId = boardIdFor({ mode: this.mode, id: this.content.id });
    let boardPreview = null;
    if (complete || final.progressPct > 0) {
      boardPreview = this.recordScore(boardId, entry);
    }

    // Slight delay so the completion wave reads before the overlay.
    const delay = this.store.data.settings.a11y.reducedMotion ? 150 : 1400;
    setTimeout(() => {
      this.appState = 'results';
      this.showResults(ev, final, unlockedAch, boardPreview, boardId, entry);
    }, delay);
  }

  recordScore(boardId, entry) {
    const boards = this.store.loadBoards();
    const list = boards[boardId] || [];
    list.push(entry);
    list.sort(compareBoardEntries);
    boards[boardId] = list.slice(0, 50);
    this.store.saveBoards(boards);
    const rank = list.indexOf(entry) + 1;
    let preview = `Local board: #${rank} of ${list.length}`;
    // Rival best tracking.
    this.store.update((d) => {
      for (const r of d.rivals) {
        if (r.name === entry.name) r.best = Math.max(r.best || 0, entry.score);
      }
      if (!d.rivals.some((r) => r.name === entry.name)) {
        // self entry tracked implicitly by boards
      }
    });
    if (this.content.meta.ranked && this.platform.hosted && !this._dailyExcluded) {
      this.platform.submitScore(boardId, entry)
        .then((res) => {
          if (res?.rank) this.ui.toast(`Global board: #${res.rank}`);
        })
        .catch(() => { /* local result already shown; labeled casual */ });
      preview += ' · submitted for validation';
    } else if (this.content.meta.ranked) {
      preview += ' · casual (offline)';
    }
    return preview;
  }

  starsFor(state) {
    if (state.status !== 'complete') return 0;
    let stars = 1;
    if (state.stats.errors === 0) stars++;
    if (state.par.timeMs === 0 || state.elapsedMs <= state.par.timeMs) stars++;
    return stars;
  }

  showResults(ev, final, achievements, boardPreview, boardId, entry) {
    const state = this.session.state;
    const complete = ev.status === 'complete';
    const reasons = {
      'all-filled': 'Canvas complete!',
      'move-limit': 'Out of actions',
      'time-limit': 'Out of time',
      'error-limit': 'Too many errors',
      'abandoned': 'Round abandoned',
    };
    let canNext = false;
    let nextLabel = 'Next';
    if (this.mode === 'journey' && complete) {
      const idx = JOURNEY.findIndex((s) => s.id === this.content.id);
      if (idx >= 0 && idx + 1 < JOURNEY.length) { canNext = true; nextLabel = 'Next stage'; }
    } else if (this.mode === 'learn') {
      const idx = LESSONS.findIndex((l) => l.id === this.content.id);
      if (idx >= 0 && idx + 1 < LESSONS.length) { canNext = true; nextLabel = 'Next lesson'; }
    }
    this._lastBoardId = boardId;
    this.ui.showHUD(false);
    this.ui.showScreen('results');
    this.ui.renderResults({
      headline: reasons[ev.reason] || ev.status,
      stars: this.mode === 'journey' ? this.starsFor(state) : 0,
      breakdown: final,
      progressText: `${final.progressPct}% painted · ${final.correct} cells · ${final.actions} actions · best combo ×${final.bestCombo} · ${fmtTime(final.elapsedMs)}`,
      achievements,
      boardPreview: complete ? boardPreview : null,
      seedText: `Seed ${this.content.seed} · content v${this.content.version}`,
      canNext, nextLabel,
    });
    this.ui.announce(`${reasons[ev.reason]}. Score ${final.total}. ${Math.round(final.progressPct)} percent painted.`, true);
  }

  resultsNext() {
    if (this.mode === 'journey') {
      const idx = JOURNEY.findIndex((s) => s.id === this.content.id);
      const next = JOURNEY[idx + 1];
      if (next) { this.showSetup('journey', next); return; }
    }
    if (this.mode === 'learn') {
      const idx = LESSONS.findIndex((l) => l.id === this.content.id);
      const next = LESSONS[idx + 1];
      if (next) { this.startLesson(next); return; }
    }
    this.toTitle();
  }

  resultsRetry() {
    this.platform.track('retry', { mode: this.mode });
    if (this.mode === 'learn') {
      const lesson = LESSONS.find((l) => l.id === this.content.id);
      if (lesson) { this.startLesson(lesson); return; }
    }
    if (this._lastContent) {
      // Same seed → same board: a true retry.
      const c = this._lastContent;
      const mode = this.mode;
      this.startRound(JSON.parse(JSON.stringify(c)), mode);
    }
  }

  // --- replay (deterministic watch) ---
  async resultsReplay() {
    if (!this.session) return;
    const snapshot = this.session.snapshot();
    this.ui.showScreen(null);
    this.ui.showHUD(true);
    this.replayMode = true;
    this.ui.toast('Replay — press Esc to exit');
    const replay = new Session(snapshot.content, {
      onEvents: (events, state) => this.renderer?.applyEvents(events, state),
    });
    this.renderer.setBoard(snapshot.content, this.resolvedPalette());
    this.renderer.syncState(replay.state);
    replay.start();
    for (const cmd of snapshot.log) {
      if (!this.replayMode) break;
      if (cmd.type === 'start') continue;
      if (cmd.type === 'tick') continue; // ticks replayed implicitly below
      replay.dispatch({ ...cmd });
      this.ui.setProgress(replay.state.stats.correct, replay.state.w * replay.state.h);
      await sleep(this.store.data.settings.a11y.reducedMotion ? 20 : 90);
    }
    if (this.replayMode) {
      this.ui.toast('Replay finished');
      await sleep(900);
      this.replayMode = false;
      this.appState = 'results';
      this.ui.showScreen('results');
      this.ui.showHUD(false);
    }
  }

  exitReplay() {
    if (!this.replayMode) return;
    this.replayMode = false;
    this.appState = 'results';
    this.ui.showScreen('results');
    this.ui.showHUD(false);
    if (this.session) {
      this.renderer.setBoard(this.content, this.resolvedPalette());
      this.renderer.syncState(this.session.state);
    }
  }

  // --- pause / resume / leave ---
  pauseToggle() {
    if (this.replayMode) { this.exitReplay(); return; }
    if (!this.session) return;
    if (this.session.status === 'active') {
      this.session.pause();
      this.appState = 'paused';
      const s = this.session.state;
      this.ui.openPause(`${this.content.meta.title} — ${s.stats.correct}/${s.w * s.h} cells, ${fmtTime(s.elapsedMs)} elapsed`);
      this.autosaveNow();
    } else if (this.session.status === 'paused') {
      this.resumeRound();
    }
  }

  resumeRound() {
    if (!this.session) return;
    this.session.resume();
    this.appState = 'active';
    this.ui.closePause();
  }

  async leaveRound() {
    if (!this.session) { this.toTitle(); return; }
    const terminal = rules.isTerminal(this.session.state);
    if (!terminal) {
      const yes = await this.ui.confirm('Leave this round? Progress on this canvas will be lost.', 'Leave round');
      if (!yes) return;
      this.session.abandon();
    }
    this.ui.closePause();
    this.toTitle();
  }

  async restartRound() {
    const yes = await this.ui.confirm('Restart this canvas from scratch?', 'Restart round');
    if (!yes) return;
    this.ui.closePause();
    this.resultsRetry();
  }

  teardownSession(clearSnapshot = true) {
    clearTimeout(this._cdT);
    this.ui.countdown(null);
    this.session = null;
    this.lesson = null;
    this.stroke = null;
    this.pointers.clear();
    this.replayMode = false;
    this.platform.stopPresence();
    if (clearSnapshot) this.store.clearSessionSnapshot();
  }

  resumeSnapshot(snapshot) {
    try {
      this.teardownSession(false);
      this.content = snapshot.content;
      this.mode = snapshot.content.meta?.mode || 'practice';
      this._lastContent = this.content;
      this.session = Session.restore(snapshot, {
        now: Date.now(),
        onEvents: (events, state) => this.onSessionEvents(events, state),
        onState: () => this.autosaveSoon(),
      });
      const away = this.session.lastAwayDuration || 0;
      if (this.session.status === 'active') this.session.pause();
      this.appState = 'paused';
      if (this.renderer) {
        this.renderer.setTheme(getTheme(this.store.data.cosmetics.theme));
        this.renderer.setBoard(this.content, this.resolvedPalette());
        this.renderer.syncState(this.session.state);
      }
      this.ui.showScreen(null);
      this.ui.showHUD(true);
      this.ui.syncLayout();
      this.ui.setHudInfo(this.content.meta.title, this.mode.replace('-', ' '));
      this.ui.setObjective(this.objectiveText(this.content));
      this.ui.setTool(this.tool, this.content.ruleset.tools);
      this.refreshHud(true);
      const awayText = away > 45000 ? ` You were away ${fmtTime(away)} — the table waited, clock paused.` : '';
      this.ui.openPause(`Restored from your last safe snapshot.${awayText}`);
      this.ui.toast(`Round restored.${awayText}`);
    } catch (err) {
      console.error('restore failed', err);
      this.store.clearSessionSnapshot();
      this.ui.toast('Could not restore the saved round — starting fresh.');
    }
  }

  autosaveSoon() {
    this._autosaveDirty = true;
  }

  autosaveNow() {
    if (this.session && !rules.isTerminal(this.session.state) && this.session.log.length > 0) {
      this.store.saveSessionSnapshot(this.session.snapshot());
    }
    this._autosaveDirty = false;
  }

  // ---------------------------------------------------------------- input --
  bindings() {
    const out = {};
    const overrides = this.store.data.settings.controls.bindings || {};
    for (const a of DEFAULT_BINDINGS) out[overrides[a.id] || a.def] = a.id;
    return out;
  }

  bindInput() {
    // Pointer/touch with capture; tap/drag/camera-gesture by thresholds.
    document.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    document.addEventListener('pointermove', (e) => this.onPointerMove(e));
    document.addEventListener('pointerup', (e) => this.onPointerUp(e));
    document.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    document.addEventListener('lostpointercapture', (e) => this.onPointerUp(e, true));
    document.addEventListener('wheel', (e) => {
      if (this.appState !== 'active' && this.appState !== 'paused') return;
      if (e.target.closest('.menu-card, .overlay-card, .rail, .tray, .drawer')) return;
      e.preventDefault();
      this.renderer?.zoomBy(e.deltaY > 0 ? 1.12 : 0.89);
      this.noteCameraMove();
    }, { passive: false });
    document.addEventListener('contextmenu', (e) => {
      if (e.target === $('gl') || e.target === $('flat')) e.preventDefault();
    });
    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Visibility: backgrounding pauses the solo simulation.
    document.addEventListener('visibilitychange', () => {
      const hidden = document.hidden;
      this.renderer?.setHidden(hidden);
      if (hidden) {
        if (this.session?.status === 'active') this.pauseToggle();
        this.audio.suspend();
        this.autosaveNow();
      } else {
        this.audio.resume();
      }
    });
    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.renderer?.resize(), 60));
    window.addEventListener('beforeunload', () => {
      this.autosaveNow();
      this.platform.activityEnd();
    });

    // First gesture unlocks audio.
    const unlock = () => {
      if (this.audio.ensure()) {
        this.audio.setMuted(this.store.data.settings.audio.muted);
        for (const bus of ['music', 'effects', 'ambience', 'voice']) {
          this.audio.setVolume(bus, this.store.data.settings.audio[bus]);
        }
        this.audio.startMusic(this.store.data.cosmetics.theme);
        document.removeEventListener('pointerdown', unlock);
        document.removeEventListener('keydown', unlock);
      }
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);

    // Main loop.
    const loop = (t) => {
      requestAnimationFrame(loop);
      const dt = Math.min(100, t - (this._lastFrame || t));
      this._lastFrame = t;
      this.frame(dt || 16);
    };
    requestAnimationFrame(loop);
  }

  activeCanvas() {
    return $(this.renderer?.kind === '2d' ? 'flat' : 'gl');
  }

  frame(dt) {
    // Frame-rate tracking → dynamic render scale before touching sim rate.
    this._frameAvg = this._frameAvg * 0.95 + dt * 0.05;
    this._scaleCheckT = (this._scaleCheckT || 0) + dt;
    if (this._scaleCheckT > 2000 && this.renderer?.kind === '3d') {
      this._scaleCheckT = 0;
      if (this._frameAvg > 24 && this._renderScale > 0.65) {
        this._renderScale = Math.max(0.65, this._renderScale - 0.15);
        this.renderer.setRenderScale(this._renderScale);
      } else if (this._frameAvg < 12 && this._renderScale < 1) {
        this._renderScale = Math.min(1, this._renderScale + 0.1);
        this.renderer.setRenderScale(this._renderScale);
      }
    }

    // Authoritative clock: quantized tick commands while active.
    if (this.session?.status === 'active' && !this.replayMode) {
      this._tickAcc += dt;
      if (this._tickAcc >= 200) {
        const q = Math.floor(this._tickAcc / 100) * 100;
        this._tickAcc -= q;
        this.session.advanceTime(q);
      }
      const s = this.session.state;
      if (s.ruleset.timeLimitMs != null) {
        const left = Math.max(0, s.ruleset.timeLimitMs - s.elapsedMs);
        this.ui.setTimer(fmtTime(left), true, left < 15000);
      } else {
        this.ui.setTimer(fmtTime(s.elapsedMs), true, false);
      }
      this.audio.setMusicIntensity(rules.progress(s));
    }

    if (this._autosaveDirty) {
      this._autosaveT += dt;
      if (this._autosaveT > 4000) { this._autosaveT = 0; this.autosaveNow(); }
    }

    this.pollGamepad(dt);
    this.renderer?.update(dt);
  }

  // --- pointer/touch ---
  onPointerDown(e) {
    if (this.appState !== 'active') return;
    if (e.target !== $('gl') && e.target !== $('flat')) return;
    this.audio.ensure();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t: performance.now() });
    if (this.pointers.size === 2) {
      // Two fingers → camera gesture (pinch/pan). Cancel any stroke safely.
      this.endStroke();
      this._pinchStart = null;
      return;
    }
    try { e.target.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    if (this.panMode || e.button === 1 || e.button === 2) return; // camera drag
    const cell = this.renderer?.screenToCell(e.clientX, e.clientY) ?? -1;
    if (cell >= 0) {
      if (this.tool === 'region') {
        this.commitFill(cell, 'region');
      } else {
        this.stroke = { id: `stroke-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`, last: -1, moved: false };
        this.commitFill(cell, 'brush', false);
      }
    }
  }

  onPointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (this.appState !== 'active') return;
    const isCanvas = e.target === $('gl') || e.target === $('flat');

    // Pinch zoom / two-finger pan.
    if (this.pointers.size === 2 && p) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this._pinchStart) {
        this.renderer?.zoomBy(this._pinchStart.dist / Math.max(1, dist));
        this.renderer?.panBy(mid.x - this._pinchStart.mid.x, mid.y - this._pinchStart.mid.y);
        this.noteCameraMove();
      }
      this._pinchStart = { dist, mid };
      return;
    }

    if (!p) {
      // Hover without touch: preview legal targets.
      if (isCanvas && e.pointerType === 'mouse') this.updateHover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const totalMove = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
    if (totalMove > 10 && this.stroke) this.stroke.moved = true;

    if (this.panMode || e.buttons === 4 || e.buttons === 2) {
      this.renderer?.panBy(dx, dy);
      this.noteCameraMove();
      return;
    }
    if (this.stroke && this.tool === 'brush') {
      const cell = this.renderer?.screenToCell(e.clientX, e.clientY) ?? -1;
      if (cell >= 0 && cell !== this.stroke.last) {
        // Interpolate between cells so fast drags don't skip.
        for (const c of this.cellsBetween(this.stroke.last, cell)) {
          this.commitFill(c, 'brush', true);
        }
      }
    } else if (isCanvas && !this.stroke) {
      this.updateHover(e.clientX, e.clientY);
    }
  }

  onPointerUp(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this._pinchStart = null;
    if (this.appState !== 'active') { this.endStroke(); return; }
    if (p && this.stroke && !cancelled) {
      const dt = performance.now() - p.t;
      const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (!this.stroke.moved && moved < 10 && dt < 600 && this.stroke.last === -1) {
        // Pure tap that didn't hit a cell at down — try again at up.
        const cell = this.renderer?.screenToCell(e.clientX, e.clientY) ?? -1;
        if (cell >= 0) this.commitFill(cell, this.tool === 'region' ? 'region' : 'brush', false);
      }
    }
    this.endStroke();
  }

  endStroke() {
    this.stroke = null;
  }

  updateHover(x, y) {
    const cell = this.renderer?.screenToCell(x, y) ?? -1;
    if (cell === this.hoverCell) return;
    this.hoverCell = cell;
    this.renderer?.setHover(cell);
    if (cell >= 0 && this.tool === 'region' && this.session) {
      const region = rules.regionAt(this.session.state, cell);
      const target = this.session.state.targets[cell];
      this.renderer?.setGhost(target === this.session.state.selected ? region : []);
    } else {
      this.renderer?.setGhost(null);
    }
  }

  cellsBetween(a, b) {
    if (a < 0) return [b];
    const w = this.session.state.w;
    const ax = a % w, ay = Math.floor(a / w);
    const bx = b % w, by = Math.floor(b / w);
    const cells = [];
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(ax + (bx - ax) * (i / steps));
      const y = Math.round(ay + (by - ay) * (i / steps));
      cells.push(y * w + x);
    }
    return cells;
  }

  commitFill(cell, tool, isContinuation) {
    const s = this.session;
    if (!s || s.status !== 'active') return;
    const strokeId = this.stroke?.id;
    const r = s.fill(cell, s.state.selected, tool, tool === 'brush' ? strokeId : null, isContinuation);
    if (r.ok && this.stroke) this.stroke.last = cell;
    return r;
  }

  // --- keyboard ---
  onKeyDown(e) {
    // Settings binding capture first.
    if (this.ui.captureBindingKey(e.key)) { e.preventDefault(); return; }
    if (e.target.matches('input, select, textarea')) return;
    if (this.replayMode && e.key === 'Escape') { this.exitReplay(); return; }

    const action = this.bindings()[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    const inRound = this.appState === 'active' || this.appState === 'paused';

    if (action === 'pause' && inRound) { e.preventDefault(); this.pauseToggle(); return; }
    if (action === 'cancel') {
      if (this.ui.pauseOpen) { e.preventDefault(); this.resumeRound(); return; }
      if (inRound && this.appState === 'active') { e.preventDefault(); this.pauseToggle(); return; }
    }
    if (this.appState !== 'active' || !this.session) return;

    const s = this.session.state;
    const num = Number(e.key);
    if (Number.isInteger(num) && e.key !== ' ' && num >= 0 && num < s.palette.length && num <= 8) {
      // Number keys pick swatches (0/• picks background).
      e.preventDefault();
      this.session.select(num);
      return;
    }

    switch (action) {
      case 'fill':
        e.preventDefault();
        if (this.keyboardCell >= 0) this.commitFill(this.keyboardCell, this.tool === 'region' ? 'region' : 'brush', false);
        return;
      case 'undo': e.preventDefault(); this.session.undo(); return;
      case 'hint': e.preventDefault(); this.session.hint(); return;
      case 'nextColor': e.preventDefault(); this.cycleColor(1); return;
      case 'prevColor': e.preventDefault(); this.cycleColor(-1); return;
      case 'regionTool': e.preventDefault(); this.setTool('region'); return;
      case 'brushTool': e.preventDefault(); this.setTool('brush'); return;
      case 'camReset': e.preventDefault(); this.renderer?.resetCamera(); this.noteCameraMove(); return;
      default: break;
    }

    // Cursor navigation among legal targets.
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
    const dir = dirs[e.key];
    if (dir) {
      e.preventDefault();
      if (this.keyboardCell < 0) {
        const la = rules.legalActions(s);
        this.keyboardCell = la.colors.find((c) => c.color === s.selected)?.sample ?? la.colors[0]?.sample ?? 0;
      } else {
        const x = this.keyboardCell % s.w + dir[0];
        const y = Math.floor(this.keyboardCell / s.w) + dir[1];
        if (x >= 0 && y >= 0 && x < s.w && y < s.h) this.keyboardCell = y * s.w + x;
      }
      this.renderer?.setKeyboardCursor(this.keyboardCell);
      const t = s.targets[this.keyboardCell];
      this.ui.announce(`Cell ${this.keyboardCell % s.w + 1}, ${Math.floor(this.keyboardCell / s.w) + 1} — wants color ${t === 0 ? 'background' : t}${s.filled[this.keyboardCell] ? ', filled' : ''}`);
      return;
    }
  }

  cycleColor(dir) {
    const s = this.session?.state;
    if (!s) return;
    const n = s.palette.length;
    let c = s.selected;
    for (let i = 0; i < n; i++) {
      c = (c + dir + n) % n;
      if (!s.ruleset.sequence || c === s.seqColor) break;
    }
    this.session.select(c);
  }

  setTool(tool) {
    if (tool === 'region' && this.session && !this.session.state.ruleset.tools.region) {
      this.ui.toast('The region tool is disabled in this ruleset.');
      return;
    }
    this.tool = tool;
    this.ui.setTool(tool, this.session?.state.ruleset.tools);
    this.audio.play('ui.tap');
  }

  // --- gamepad ---
  pollGamepad(dt) {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find(Boolean);
    if (!pad || this.appState !== 'active' || !this.session) return;
    const gp = this._gamepad;
    const pressed = (i) => pad.buttons[i]?.pressed;
    const edge = (i) => {
      const now = pressed(i);
      const was = gp.buttons[i];
      gp.buttons[i] = now;
      return now && !was;
    };
    // Axes pan the camera.
    const ax = Math.abs(pad.axes[0]) > 0.25 ? pad.axes[0] : 0;
    const ay = Math.abs(pad.axes[1]) > 0.25 ? pad.axes[1] : 0;
    if (ax || ay) {
      this.renderer?.panBy(-ax * dt * 0.5, -ay * dt * 0.5);
      this.noteCameraMove();
    }
    const zoom = (pressed(6) ? 1 : 0) - (pressed(7) ? 1 : 0); // LT/RT zoom
    if (zoom) this.renderer?.zoomBy(1 + zoom * dt * 0.0012);

    // D-pad cursor movement with repeat.
    const now = performance.now();
    const dpad = [[12, 0, -1], [13, 0, 1], [14, -1, 0], [15, 1, 0]];
    for (const [btn, dx, dy] of dpad) {
      if (pressed(btn) && (edge(btn) || now > gp.repeatAt)) {
        gp.repeatAt = now + 180;
        const s = this.session.state;
        if (this.keyboardCell < 0) this.keyboardCell = 0;
        const x = this.keyboardCell % s.w + dx;
        const y = Math.floor(this.keyboardCell / s.w) + dy;
        if (x >= 0 && y >= 0 && x < s.w && y < s.h) {
          this.keyboardCell = y * s.w + x;
          this.renderer?.setKeyboardCursor(this.keyboardCell);
        }
      }
    }
    if (edge(0) && this.keyboardCell >= 0) this.commitFill(this.keyboardCell, this.tool === 'region' ? 'region' : 'brush', false);
    if (edge(1)) this.pauseToggle();
    if (edge(2)) this.session.undo();
    if (edge(3)) this.session.hint();
    if (edge(4)) this.cycleColor(-1);
    if (edge(5)) this.cycleColor(1);
    if (edge(8)) { this.renderer?.resetCamera(); this.noteCameraMove(); }
    if (edge(9)) this.pauseToggle();
  }

  // ------------------------------------------------------------- settings --
  applySetting(path, value) {
    const parts = path.split('.');
    this.store.update((d) => {
      let obj = d.settings;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = value;
    });
    this.platform.setTelemetryConsent(this.store.data.settings.telemetryConsent);
    this.platform.track('settings-change', { category: parts[0] });
    this.applySettingsToDom();
    this.applyA11yToRenderer();
    if (path.startsWith('audio.')) {
      const bus = parts[1];
      if (bus === 'muted') this.audio.setMuted(value);
      else this.audio.setVolume(bus, value);
    }
    if (path === 'graphics.tier') this.applyQuality();
    if (path === 'a11y.palette' && this.content) {
      this.renderer?.setBoard(this.content, this.resolvedPalette());
      if (this.session) this.renderer.syncState(this.session.state);
      this.updatePalette();
    }
  }

  applySettingsToDom() {
    const s = this.store.data.settings;
    document.body.classList.toggle('reduced-motion', s.a11y.reducedMotion);
    document.body.classList.toggle('high-contrast', s.a11y.highContrast);
    document.body.classList.toggle('larger-text', s.a11y.largerText);
    document.body.classList.toggle('left-handed', s.a11y.leftHanded);
    this.audio.hapticsEnabled = s.a11y.haptics;
  }

  applyA11yToRenderer() {
    if (!this.renderer) return;
    const s = this.store.data.settings;
    this.renderer.setReducedMotion(s.a11y.reducedMotion);
    this.renderer.setCellLabels(s.a11y.cellLabels);
  }

  applyTheme() {
    const theme = getTheme(this.store.data.cosmetics.theme);
    this.renderer?.setTheme(theme);
    if (this.audio.ready) this.audio.startAmbience(theme.ambience);
  }

  applyQuality() {
    if (!this.renderer) return;
    let tier = this.store.data.settings.graphics.tier;
    if (tier === 'auto') {
      const coarse = matchMedia('(pointer: coarse)').matches;
      const small = Math.min(screen.width, screen.height) < 800;
      const lowMem = (navigator.deviceMemory || 8) <= 3;
      tier = lowMem ? 'low' : coarse && small ? 'medium' : 'high';
    }
    this._renderScale = 1;
    this.renderer.setQuality(tier);
    this.renderer.setReducedMotion(this.store.data.settings.a11y.reducedMotion);
  }

  // --------------------------------------------------------- cloud save ----
  async syncCloudSave() {
    const remote = await this.platform.cloudLoad();
    if (!remote?.doc) return;
    const localDoc = this.store.exportDoc();
    const resolution = SaveStore.resolveRevision(localDoc, remote.doc);
    if (resolution === 'remote') {
      try { this.store.importDoc(remote.doc); } catch { /* keep local */ }
    } else if (resolution === 'conflict') {
      const useRemote = await this.ui.confirm(
        'A different save exists in the cloud. Use the cloud copy? (Choose Cancel to keep this device\'s copy — both are preserved until you pick.)',
        'Save conflict'
      );
      if (useRemote) {
        try { this.store.importDoc(remote.doc); } catch { /* keep local */ }
      } else {
        this.platform.cloudSave(this.store.exportDoc());
      }
    }
  }

  // -------------------------------------------------------------- boards ---
  showBoard(boardId, scope = 'global') {
    this._boardId = boardId || this._boardId || boardIdFor({ mode: 'score-chase', id: `chase-${this.platform.isoWeekString()}` });
    this._boardScope = scope;
    const local = (this.store.loadBoards()[this._boardId] || []).map((e) => ({ ...e }));
    const friends = new Set([this.store.data.profile.name, ...(this.store.data.rivals || []).map((r) => r.name)]);
    const render = (entries, note) => {
      const filtered = scope === 'friends' ? entries.filter((e) => friends.has(e.name)) : entries;
      this.ui.renderBoard(filtered.sort(compareBoardEntries), scope, note, this.store.data.profile.name);
    };
    $('board-h').textContent = 'Leaderboard';
    $('board-sub').textContent = `Board ${this._boardId}`;
    if (this.platform.hosted) {
      this.platform.leaderboard(this._boardId, 'global')
        .then((res) => render(res.entries || local, 'Validated global board.'))
        .catch(() => render(local, 'Offline — showing local (casual) board.'));
    } else {
      render(local, 'Local board — casual, unvalidated.');
    }
    this.ui.showScreen('board');
  }

  // -------------------------------------------------------------- helpers --
  _handlers() {
    return {
      onNav: (where) => {
        if (where === 'title') {
          if (this.appState === 'paused') { this.ui.showScreen(null); this.ui.openPause(''); }
          else this.toTitle();
        }
      },
      onPlay: () => {
        // Short path to play: continue journey at first unfinished stage.
        const stars = this.store.data.journey.stars || {};
        const next = JOURNEY.find((s) => !(stars[s.id] > 0)) || JOURNEY[JOURNEY.length - 1];
        this.mode = 'journey';
        this.showSetup('journey', next);
      },
      onMode: (mode) => { this.audio.play('ui.open'); this.openMode(mode); },
      onSetupStart: () => this.startSetup(),
      onShowProfile: () => {
        this.ui.renderProfile(this.store.data, ACHIEVEMENTS, this.platform.hosted);
        this.ui.showScreen('profile');
      },
      onShowSettings: (from) => {
        this._settingsFrom = from;
        this.renderSettingsScreen();
        this.ui.showScreen('settings');
      },
      onShowHelp: () => {
        this.ui.renderHelp(this.helpCards());
        this.ui.showScreen('help');
      },
      onPauseToggle: () => this.pauseToggle(),
      onResume: () => this.resumeRound(),
      onRestartRound: () => this.restartRound(),
      onLeaveRound: () => this.leaveRound(),
      onSkipAnim: () => { this.renderer?.settle(); this.ui.toast('Animations skipped — state is exact.'); },
      onUndo: () => this.session?.undo(),
      onHint: () => this.session?.hint(),
      onTool: (tool) => this.setTool(tool),
      onZoom: (f) => { this.renderer?.zoomBy(f); this.noteCameraMove(); },
      onCamReset: () => { this.renderer?.resetCamera(); this.noteCameraMove(); },
      onPanMode: () => {
        this.panMode = !this.panMode;
        this.ui.setPanMode(this.panMode);
        this.ui.toast(this.panMode ? 'Pan mode — drag moves the camera' : 'Paint mode');
      },
      onSelectColor: (idx) => this.session?.select(idx),
      onCycleColor: (dir) => this.cycleColor(dir),
      onResultsNext: () => this.resultsNext(),
      onResultsRetry: () => this.resultsRetry(),
      onResultsReplay: () => this.resultsReplay(),
      onSetting: (path, value) => this.applySetting(path, value),
      onTheme: (id) => {
        this.store.update((d) => { d.cosmetics.theme = id; });
        this.applyTheme();
        this.ui.syncSettings(this.store.data.settings, THEMES, this.store.data.cosmetics);
      },
      onReplayTutorials: () => {
        this.store.update((d) => { d.tutorials.done = []; });
        this.ui.toast('Tutorials reset — find them under Learn.');
      },
      onWipe: async () => {
        const yes = await this.ui.confirm('Erase all local progress, settings and boards? This cannot be undone.', 'Erase local data');
        if (yes) {
          localStorage.clear();
          location.reload();
        }
      },
      onAddRival: (name) => {
        this.store.update((d) => {
          if (!d.rivals.some((r) => r.name === name)) d.rivals.push({ name, best: 0 });
        });
        this.ui.renderRivals(this.store.data.rivals);
      },
      onRemoveRival: (name) => {
        this.store.update((d) => { d.rivals = d.rivals.filter((r) => r.name !== name); });
        this.ui.renderRivals(this.store.data.rivals);
      },
      onRename: (name) => {
        if (name) this.store.update((d) => { d.profile.name = name; d.profile.guest = false; });
      },
      onCloudSync: () => this.syncCloudSave().then(() => this.ui.toast('Cloud save synced.')),
      onBoardScope: (scope) => this.showBoard(this._boardId, scope),
    };
  }

  renderSettingsScreen() {
    this.ui.syncSettings(this.store.data.settings, THEMES, this.store.data.cosmetics);
    this.ui.renderBindings(DEFAULT_BINDINGS, this.store.data.settings.controls.bindings, (actionId, key) => {
      this.store.update((d) => { d.settings.controls.bindings[actionId] = key; });
      this.renderSettingsScreen();
      this.ui.toast(`Binding updated: ${actionId} → ${key}`);
    });
  }

  helpCards() {
    const b = {};
    const overrides = this.store.data.settings.controls.bindings || {};
    for (const a of DEFAULT_BINDINGS) b[a.id] = (overrides[a.id] || a.def).toUpperCase();
    return [
      { title: 'Goal', body: 'Every cell hides a target color. Fill the whole canvas to reveal the artwork. The palette shows how many cells each color still needs.' },
      { title: 'Paint', body: `Select a swatch, then click or drag across glowing cells. Keyboard: arrows move the cursor, <kbd>${b.fill}</kbd> paints. Drag only lands where the color belongs.` },
      { title: 'Region tool', body: `Press <kbd>${b.regionTool}</kbd> or the Region button, then click a shape to flood every connected cell of that color. It only fills cells matching your selected color.` },
      { title: 'Camera', body: `Wheel or pinch to zoom, right-drag or Pan mode to move, <kbd>${b.camReset}</kbd> to refit. On touch, two fingers pan and pinch.` },
      { title: 'Hints & undo', body: `<kbd>${b.hint}</kbd> highlights a legal cell (small score cost). <kbd>${b.undo}</kbd> reverts your last fill where the ruleset allows it.` },
      { title: 'Rulesets', body: 'Challenges change the contract: move limits, time limits, locked color order, or errors that count. The setup screen always shows the rules before you commit.' },
      { title: 'Scoring', body: 'Cells ×10, rising combo bonus, region and completion bonuses, time bonus under par. Errors and hints cost points. Ties break on completion, errors, then time.' },
      { title: 'Access', body: 'Numbers, shapes and labels reinforce color. Reduced motion, high contrast, color-vision palettes, larger text and left-handed layout live in Settings.' },
    ];
  }
}

// ---------------------------------------------------------------------------
function detectWebGL() {
  try {
    const cv = document.createElement('canvas');
    return !!(cv.getContext('webgl2') || cv.getContext('webgl'));
  } catch { return false; }
}

function frame() {
  // rAF with a timeout fallback so boot never stalls in backgrounded or
  // headless contexts where animation frames may be starved.
  return new Promise((r) => {
    const t = setTimeout(r, 60);
    requestAnimationFrame(() => { clearTimeout(t); r(); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const app = new App();
app.boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('boot-status');
  if (el) el.textContent = `Boot failed: ${err.message}. Your save is preserved; try reloading.`;
});
window.__app = app; // debug/validation handle

// Headless smoke test: ?selftest=1 drives a full round through the real
// session/UI/renderer stack and reports via console + DOM marker.
// ?demo=1 opens a half-finished round for visual captures.
if (typeof location !== 'undefined') {
  const params = new URLSearchParams(location.search);
  if (params.get('selftest') === 'lesson') runLessonSelfTest(app);
  else if (params.has('selftest')) runSelfTest(app, params.has('stay'));
  else if (params.has('demo')) runDemo(app, params.get('demo'));
  else if (params.has('screen')) {
    // Debug capture helper: jump straight to a menu screen after boot.
    const name = params.get('screen');
    const wait = setInterval(() => {
      if (document.getElementById('app').dataset.screen !== 'title') return;
      clearInterval(wait);
      if (name === 'journey') app.openMode('journey');
      else if (name === 'learn') app.openMode('learn');
      else if (name === 'settings') app._handlers().onShowSettings();
      else if (name === 'help') app._handlers().onShowHelp();
      else if (name === 'profile') app._handlers().onShowProfile();
      else if (name === 'setup-daily') app.showSetup('daily', null);
    }, 100);
  }
}

async function runDemo(app, pctStr) {
  const pct = Math.max(0, Math.min(95, Number(pctStr) || 45)) / 100;
  const waitFor = (fn, timeout = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('demo timeout'));
      setTimeout(poll, 50);
    };
    poll();
  });
  await waitFor(() => document.getElementById('app').dataset.screen === 'title');
  await waitFor(() => !!app.renderer);
  app.startRound(practiceContent('standard', 'demo-capture'), 'practice');
  await waitFor(() => app.appState === 'active');
  const s = app.session;
  const target = Math.floor(s.state.targets.length * pct);
  let guard = 20000;
  while (s.state.stats.correct < target && guard-- > 0) {
    const la = legal(s.state);
    if (!la.colors.length) break;
    const pick = la.colors[0];
    s.select(pick.color);
    s.fill(pick.sample, pick.color, 'region');
    s.advanceTime(700);
  }
  app.renderer.setHover(42);
  if (app.renderer.getStats) console.log('[demo] render stats', JSON.stringify(app.renderer.getStats()));
}

async function runSelfTest(app, stay = false) {
  const log = (m) => console.log('[selftest]', m);
  const waitFor = (fn, timeout = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 50);
    };
    poll();
  });
  try {
    await waitFor(() => document.getElementById('app').dataset.screen === 'title');
    log('title reached');
    if (!app.renderer) await waitFor(() => !!app.renderer);
    log(`renderer: ${app.renderer.kind}`);

    // Start a practice round through the setup screen.
    app.openMode('practice');
    await waitFor(() => document.getElementById('app').dataset.screen === 'setup');
    app.startSetup();
    await waitFor(() => app.appState === 'active', 20000);
    log('round active');

    // Camera + tool interactions.
    app.renderer.zoomBy(0.8);
    app.renderer.panBy(30, 20);
    app.setTool('region');
    app.setTool('brush');

    // Fill the whole canvas via the validated command path.
    const s = app.session;
    let guard = 20000;
    while (!rulesComplete(s.state) && guard-- > 0) {
      const la = legal(s.state);
      if (!la.colors.length) break;
      const pick = la.colors[0];
      s.select(pick.color);
      s.fill(pick.sample, pick.color, 'region');
      s.advanceTime(500);
    }
    await waitFor(() => document.getElementById('app').dataset.screen === 'results', 20000);
    const headline = document.getElementById('results-headline').textContent;
    log(`results: "${headline}"`);
    if (!/complete/i.test(headline)) throw new Error('expected completion headline');

    // Quality tiers + themes cycle without errors.
    for (const tier of ['low', 'medium', 'high']) app.renderer.setQuality(tier);
    if (stay) {
      document.getElementById('title-note').textContent = 'SELFTEST-OK';
      console.log('SELFTEST-OK');
      return;
    }
    app.toTitle();
    await waitFor(() => document.getElementById('app').dataset.screen === 'title');
    log('returned to title');
    document.getElementById('title-note').textContent = 'SELFTEST-OK';
    console.log('SELFTEST-OK');
  } catch (err) {
    console.error('[selftest] FAILED:', err);
    const el = document.getElementById('title-note') || document.body;
    el.textContent = 'SELFTEST-FAIL ' + err.message;
  }
}

async function runLessonSelfTest(app) {
  const log = (m) => console.log('[lesson-test]', m);
  const waitFor = (fn, timeout = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('timeout'));
      setTimeout(poll, 50);
    };
    poll();
  });
  try {
    await waitFor(() => document.getElementById('app').dataset.screen === 'title');
    app.startLesson(LESSONS[0]);
    await waitFor(() => app.appState === 'active');
    await waitFor(() => app.lessonStep === 0 && !document.getElementById('lesson-box').hidden);
    log('lesson box visible, step 0');
    // Step 1: select color 1.
    app.session.select(1);
    await waitFor(() => app.lessonStep === 1);
    log('step 1 advanced on select');
    // Step 2: fill 3 cells of color 1.
    const s = app.session;
    let filled = 0;
    for (let i = 0; i < s.state.targets.length && filled < 3; i++) {
      if (s.state.targets[i] === 1 && !s.state.filled[i]) { s.fill(i, 1, 'brush'); filled++; }
    }
    await waitFor(() => app.lessonStep === 2);
    log('step 2 advanced on fills');
    // Step 3: complete the board.
    let guard = 1000;
    while (!rulesComplete(s.state) && guard-- > 0) {
      const la = legal(s.state);
      if (!la.colors.length) break;
      const pick = la.colors[0];
      s.select(pick.color);
      s.fill(pick.sample, pick.color, 'brush');
    }
    await waitFor(() => document.getElementById('app').dataset.screen === 'results');
    if (!app.store.data.tutorials.done.includes('learn-1')) throw new Error('lesson not recorded done');
    log('lesson recorded complete');
    console.log('LESSONTEST-OK');
    document.getElementById('results-headline').textContent = 'LESSONTEST-OK';
  } catch (err) {
    console.error('[lesson-test] FAILED:', err);
  }
}

function rulesComplete(state) {
  return state.status === 'complete' || state.status === 'failed' || state.status === 'abandoned';
}
function legal(state) {
  // Minimal mirror of the hint path for the self-test driver.
  const colors = {};
  for (let i = 0; i < state.targets.length; i++) {
    const t = state.targets[i];
    if (!state.filled[i]) {
      if (!colors[t]) colors[t] = { color: t, sample: i };
    }
  }
  return { colors: Object.values(colors) };
}
