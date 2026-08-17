// ui.js — semantic DOM shell: screens, HUD, overlays, settings, accessibility
// mirrors. UI state is kept separate from simulation state; closing a drawer
// can never affect a round.

export const $ = (id) => document.getElementById(id);

const SCREEN_IDS = ['boot', 'title', 'learn', 'journey', 'setup', 'results', 'profile', 'board', 'settings', 'help'];

export class UI {
  constructor() {
    this.handlers = {};
    this._lastFocus = null;
    this._confirmResolve = null;
    this._bindingCapture = null;
    this._paletteBtns = [];
    this._drawerClones = new Map();
  }

  init(handlers) {
    this.handlers = handlers;
    // Nav buttons with data-nav go back to a named screen.
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => { this.handlers.onNav?.(b.dataset.nav); });
    });
    $('btn-play').addEventListener('click', () => handlers.onPlay?.());
    $('btn-daily').addEventListener('click', () => handlers.onMode?.('daily'));
    $('btn-journey').addEventListener('click', () => handlers.onMode?.('journey'));
    $('btn-practice').addEventListener('click', () => handlers.onMode?.('practice'));
    $('btn-challenge').addEventListener('click', () => handlers.onMode?.('challenge'));
    $('btn-chase').addEventListener('click', () => handlers.onMode?.('score-chase'));
    $('btn-learn').addEventListener('click', () => handlers.onMode?.('learn'));
    $('btn-profile').addEventListener('click', () => handlers.onShowProfile?.());
    $('btn-settings').addEventListener('click', () => handlers.onShowSettings?.());
    $('btn-help').addEventListener('click', () => handlers.onShowHelp?.());
    $('btn-setup-start').addEventListener('click', () => handlers.onSetupStart?.());

    // HUD
    $('btn-hud-pause').addEventListener('click', () => handlers.onPauseToggle?.());
    $('btn-undo').addEventListener('click', () => handlers.onUndo?.());
    $('btn-hint').addEventListener('click', () => handlers.onHint?.());
    $('tool-brush').addEventListener('click', () => handlers.onTool?.('brush'));
    $('tool-region').addEventListener('click', () => handlers.onTool?.('region'));
    $('btn-zoom-in').addEventListener('click', () => handlers.onZoom?.(0.8));
    $('btn-zoom-out').addEventListener('click', () => handlers.onZoom?.(1.25));
    $('btn-cam-reset').addEventListener('click', () => handlers.onCamReset?.());
    $('btn-pan-mode').addEventListener('click', () => handlers.onPanMode?.());

    // Pause overlay
    $('btn-resume').addEventListener('click', () => handlers.onResume?.());
    $('btn-pause-settings').addEventListener('click', () => handlers.onShowSettings?.('pause'));
    $('btn-skip-anim').addEventListener('click', () => handlers.onSkipAnim?.());
    $('btn-restart-round').addEventListener('click', () => handlers.onRestartRound?.());
    $('btn-leave-round').addEventListener('click', () => handlers.onLeaveRound?.());

    // Results
    $('btn-results-next').addEventListener('click', () => handlers.onResultsNext?.());
    $('btn-results-retry').addEventListener('click', () => handlers.onResultsRetry?.());
    $('btn-results-replay').addEventListener('click', () => handlers.onResultsReplay?.());

    // Confirm dialog
    $('btn-confirm-yes').addEventListener('click', () => this._resolveConfirm(true));
    $('btn-confirm-no').addEventListener('click', () => this._resolveConfirm(false));

    // Profile
    $('btn-add-rival').addEventListener('click', () => {
      const name = $('rival-name').value.trim();
      if (name) handlers.onAddRival?.(name);
      $('rival-name').value = '';
    });
    $('profile-name').addEventListener('change', () => handlers.onRename?.($('profile-name').value.trim()));
    $('btn-cloud-sync').addEventListener('click', () => handlers.onCloudSync?.());

    // Board tabs
    $('board-tab-global').addEventListener('click', () => handlers.onBoardScope?.('global'));
    $('board-tab-friends').addEventListener('click', () => handlers.onBoardScope?.('friends'));

    // Settings inputs
    const S = (id) => $(id);
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      const el = S(`vol-${bus}`);
      el.addEventListener('input', () => handlers.onSetting?.(`audio.${bus}`, Number(el.value) / 100));
    }
    S('set-muted').addEventListener('change', () => handlers.onSetting?.('audio.muted', S('set-muted').checked));
    S('set-captions').addEventListener('change', () => handlers.onSetting?.('a11y.captions', S('set-captions').checked));
    S('set-haptics').addEventListener('change', () => handlers.onSetting?.('a11y.haptics', S('set-haptics').checked));
    S('set-tier').addEventListener('change', () => handlers.onSetting?.('graphics.tier', S('set-tier').value));
    S('set-motion').addEventListener('change', () => handlers.onSetting?.('a11y.reducedMotion', S('set-motion').checked));
    S('set-contrast').addEventListener('change', () => handlers.onSetting?.('a11y.highContrast', S('set-contrast').checked));
    S('set-text').addEventListener('change', () => handlers.onSetting?.('a11y.largerText', S('set-text').checked));
    S('set-labels').addEventListener('change', () => handlers.onSetting?.('a11y.cellLabels', S('set-labels').checked));
    S('set-palette').addEventListener('change', () => handlers.onSetting?.('a11y.palette', S('set-palette').value));
    S('set-lefty').addEventListener('change', () => handlers.onSetting?.('a11y.leftHanded', S('set-lefty').checked));
    S('set-hold').addEventListener('change', () => handlers.onSetting?.('a11y.holdToDrag', S('set-hold').checked));
    S('set-timing').addEventListener('change', () => handlers.onSetting?.('a11y.timingAssist', S('set-timing').checked));
    S('set-telemetry').addEventListener('change', () => handlers.onSetting?.('telemetryConsent', S('set-telemetry').checked));
    S('btn-replay-tutorials').addEventListener('click', () => handlers.onReplayTutorials?.());
    S('btn-wipe').addEventListener('click', () => handlers.onWipe?.());

    // Drawers
    $('btn-drawer-left').addEventListener('click', () => this.toggleDrawer('left'));
    $('btn-drawer-right').addEventListener('click', () => this.toggleDrawer('right'));

    // Palette keyboard support (radiogroup arrow keys).
    $('hud-palette').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        handlers.onCycleColor?.(e.key === 'ArrowRight' ? 1 : -1);
      }
    });

    window.addEventListener('resize', () => this.syncLayout());
    this.syncLayout();
  }

  // ------------------------------------------------------------- screens ---
  showScreen(name) {
    for (const id of SCREEN_IDS) {
      const el = $(`screen-${id}`);
      if (el) el.hidden = id !== name;
    }
    document.getElementById('app').dataset.screen = name || 'play';
    if (name) {
      const screen = $(`screen-${name}`);
      const target = screen?.querySelector('h1, h2, button');
      (screen?.querySelector('button.primary') || target)?.focus?.({ preventScroll: true });
    }
  }

  showHUD(v) {
    $('hud').hidden = !v;
    if (!v) this.closeDrawers();
  }

  setBoot(pct, text) {
    $('boot-fill').style.width = `${Math.round(pct * 100)}%`;
    if (text) $('boot-status').textContent = text;
  }

  showCompatNote(text) {
    const el = $('boot-compat');
    el.hidden = !text;
    el.textContent = text || '';
  }

  // ---------------------------------------------------------------- HUD ----
  setHudInfo(title, mode) {
    $('hud-title').textContent = title;
    $('hud-mode').textContent = mode;
  }

  setObjective(text) { $('objective-text').textContent = text; }

  setProgress(correct, total) {
    const pct = total ? Math.floor((correct / total) * 100) : 0;
    $('hud-progress').textContent = `${pct}%`;
    $('progress-fill').style.width = `${pct}%`;
    $('progress-bar').setAttribute('aria-valuenow', String(pct));
    $('progress-detail').textContent = `${correct} / ${total} cells`;
  }

  setTimer(text, visible, warn = false) {
    const el = $('hud-timer');
    el.hidden = !visible;
    el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  setMoves(text, visible, warn = false) {
    const el = $('hud-moves');
    el.hidden = !visible;
    el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  setErrors(text, visible) {
    const el = $('hud-errors');
    el.hidden = !visible;
    el.textContent = text;
  }

  setCombo(n) {
    $('combo-text').textContent = n >= 4 ? `Combo ×${n}` : '';
  }

  setLesson(title, text) {
    const box = $('lesson-box');
    if (!text) { box.hidden = true; return; }
    box.hidden = false;
    $('lesson-title').textContent = title;
    $('lesson-text').textContent = text;
  }

  setBoardStatus(text) { $('board-status').textContent = text; }

  renderPalette(palette, selected, remaining, total, opts = {}) {
    const wrap = $('hud-palette');
    wrap.textContent = '';
    this._paletteBtns = [];
    const shapes = ['●', '◆', '■', '▲', '★', '✚', '◐', '⬟'];
    palette.forEach((hex, idx) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(idx === selected));
      const left = remaining?.[idx] ?? 0;
      const tot = total?.[idx] ?? 0;
      b.setAttribute('aria-label', `Color ${idx === 0 ? 'background' : idx}, ${left} of ${tot} cells left`);
      if (left === 0 && tot > 0) b.classList.add('done');
      if (opts.lockedColor != null && idx !== opts.lockedColor) b.classList.add('locked');
      const lum = luminance(hex);
      b.style.color = lum > 0.55 ? '#101828' : '#fff';
      b.style.textShadow = lum > 0.55 ? 'none' : '0 1px 2px #000';
      b.innerHTML = `<span class="sw-num">${idx === 0 ? '•' : idx}</span>` +
        `<span class="sw-shape">${shapes[idx % shapes.length]}</span>` +
        `<span class="sw-left">${left}</span>`;
      b.addEventListener('click', () => this.handlers.onSelectColor?.(idx));
      wrap.appendChild(b);
      this._paletteBtns.push(b);
    });
  }

  setTool(tool, tools) {
    $('tool-brush').setAttribute('aria-pressed', String(tool === 'brush'));
    $('tool-region').setAttribute('aria-pressed', String(tool === 'region'));
    $('tool-region').disabled = tools && !tools.region;
  }

  setPanMode(on) { $('btn-pan-mode').setAttribute('aria-pressed', String(on)); }

  setActionStates({ canUndo, canHint }) {
    $('btn-undo').disabled = !canUndo;
    $('btn-hint').disabled = !canHint;
  }

  // ----------------------------------------------------------- journey -----
  renderJourney(chapters, stages, save, onPick) {
    const map = $('journey-map');
    map.textContent = '';
    const stars = save.journey.stars || {};
    let unlocked = true; // first stage of a chapter unlocks when previous chapter's last stage has stars
    chapters.forEach((ch, ci) => {
      const div = document.createElement('div');
      div.className = 'chapter';
      const h = document.createElement('h3');
      h.textContent = `${ci + 1}. ${ch.name}`;
      div.appendChild(h);
      const row = document.createElement('div');
      row.className = 'stage-row';
      const chapterStages = stages.filter((s) => s.meta.chapter === ci + 1);
      chapterStages.forEach((s, si) => {
        const b = document.createElement('button');
        b.className = 'stage-cell' + (s.meta.mastery ? ' mastery' : '');
        const st = stars[s.id] || 0;
        const isUnlocked = unlocked && (si === 0 || (stars[chapterStages[si - 1].id] || 0) > 0);
        b.disabled = !isUnlocked;
        b.innerHTML = `<span class="stage-num">${s.meta.mastery ? '★' : si + 1}</span>` +
          `<span class="stage-stars">${'●'.repeat(st)}${'○'.repeat(Math.max(0, 3 - st))}</span>` +
          `<span class="stage-name">${escapeHtml(s.meta.title)}</span>`;
        b.setAttribute('aria-label', `${s.meta.title}, ${st} of 3 stars${isUnlocked ? '' : ', locked'}`);
        if (isUnlocked) b.addEventListener('click', () => onPick(s));
        row.appendChild(b);
      });
      div.appendChild(row);
      map.appendChild(div);
      const last = chapterStages[chapterStages.length - 1];
      unlocked = (stars[last.id] || 0) > 0;
    });
    const done = Object.keys(save.journey.stars || {}).length;
    $('journey-sub').textContent = `${done} / ${stages.length} stages`;
  }

  renderLessons(lessons, done, onPick) {
    const list = $('lesson-list');
    list.textContent = '';
    lessons.forEach((l, i) => {
      const li = document.createElement('li');
      const isDone = done.includes(l.id);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.innerHTML = `<span class="btn-title">${i + 1}. ${escapeHtml(l.title)}${isDone ? ' ✓' : ''}</span><span class="btn-sub">${escapeHtml(l.intro)}</span>`;
      btn.addEventListener('click', () => onPick(l));
      li.appendChild(btn);
      list.appendChild(li);
    });
    $('learn-sub').textContent = `${done.length} / ${lessons.length} done`;
  }

  // ------------------------------------------------------------- results ---
  renderResults({ headline, stars, breakdown, progressText, achievements, boardPreview, seedText, canNext, nextLabel }) {
    $('results-headline').textContent = headline;
    $('results-stars').textContent = stars > 0 ? '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars)) : '';
    const t = $('results-table');
    t.textContent = '';
    const rows = [
      ['Cells painted', breakdown.base],
      ['Combo bonus', breakdown.comboBonus],
      ['Region bonus', breakdown.regionBonus],
      ['Completion bonus', breakdown.completionBonus],
      ['Time bonus', breakdown.timeBonus],
    ];
    for (const [label, val] of rows) {
      if (!val) continue;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${label}</td><td>+${val}</td>`;
      t.appendChild(tr);
    }
    if (breakdown.errorPenalty) {
      const tr = document.createElement('tr');
      tr.className = 'penalty';
      tr.innerHTML = `<td>Error penalty (${breakdown.errors})</td><td>−${breakdown.errorPenalty}</td>`;
      t.appendChild(tr);
    }
    if (breakdown.hintPenalty) {
      const tr = document.createElement('tr');
      tr.className = 'penalty';
      tr.innerHTML = `<td>Hints used</td><td>−${breakdown.hintPenalty}</td>`;
      t.appendChild(tr);
    }
    const tr = document.createElement('tr');
    tr.className = 'total';
    tr.innerHTML = `<td>Total</td><td>${breakdown.total}</td>`;
    t.appendChild(tr);
    $('results-progress').textContent = progressText;
    $('results-seed').textContent = seedText;
    const ach = $('results-achievements');
    ach.textContent = '';
    for (const a of achievements || []) {
      const b = document.createElement('span');
      b.className = 'ach-badge';
      b.textContent = `🏅 ${a.name}`;
      ach.appendChild(b);
    }
    const bm = $('board-mini');
    bm.textContent = '';
    if (boardPreview) {
      const p = document.createElement('p');
      p.className = 'dim';
      p.textContent = boardPreview;
      bm.appendChild(p);
    }
    const next = $('btn-results-next');
    next.hidden = !canNext;
    next.textContent = nextLabel || 'Next';
  }

  // ------------------------------------------------------------- profile ---
  renderProfile(save, achMeta, hosted) {
    $('profile-name').value = save.profile.name;
    $('profile-identity').textContent = hosted
      ? 'Signed in through the host shell. Progress syncs to the cloud.'
      : 'Guest profile — progress is stored on this device.';
    const s = save.stats;
    const dl = $('profile-stats');
    dl.textContent = '';
    const mins = Math.round(s.playtimeMs / 60000);
    for (const [k, v] of [
      ['Cells painted', s.cellsFilled.toLocaleString()],
      ['Rounds completed', s.roundsCompleted],
      ['Sessions', s.sessions],
      ['Playtime', mins >= 1 ? `${mins} min` : '<1 min'],
      ['Daily streak', `${save.daily.streak} day${save.daily.streak === 1 ? '' : 's'}`],
    ]) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      dl.append(dt, dd);
    }
    const list = $('ach-list');
    list.textContent = '';
    for (const a of achMeta) {
      const li = document.createElement('li');
      const at = save.achievements[a.key];
      li.className = at ? '' : 'locked';
      li.innerHTML = `<span class="ach-key">${at ? '🏅' : '○'} ${escapeHtml(a.name)}</span>` +
        `<span>${escapeHtml(a.desc)}</span>` +
        (at ? `<span class="ach-when">${new Date(at).toLocaleDateString()}</span>` : '');
      list.appendChild(li);
    }
    $('btn-cloud-sync').hidden = !hosted;
    this.renderRivals(save.rivals || []);
  }

  renderRivals(rivals) {
    const list = $('rival-list');
    list.textContent = '';
    if (!rivals.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="dim">No rivals yet — add one to compare scores locally.</span>';
      list.appendChild(li);
      return;
    }
    for (const r of rivals) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(r.name)}</span><span class="dim">best ${r.best ?? 0}</span>`;
      const del = document.createElement('button');
      del.className = 'btn ghost';
      del.textContent = 'Remove';
      del.addEventListener('click', () => this.handlers.onRemoveRival?.(r.name));
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  renderBoard(entries, scope, note, meName) {
    const list = $('board-list');
    list.textContent = '';
    if (!entries.length) {
      const li = document.createElement('li');
      li.textContent = 'No scores yet — be the first.';
      list.appendChild(li);
    }
    entries.slice(0, 20).forEach((e, i) => {
      const li = document.createElement('li');
      if (e.name === meName) li.className = 'me';
      li.textContent = `${i + 1}. ${e.name} — ${e.score} (${Math.round(e.progressPct)}%, ${e.errors} errors, ${fmtTime(e.elapsedMs)})`;
      list.appendChild(li);
    });
    $('board-tab-global').setAttribute('aria-selected', String(scope === 'global'));
    $('board-tab-friends').setAttribute('aria-selected', String(scope === 'friends'));
    $('board-note').textContent = note || '';
  }

  // ------------------------------------------------------------ settings ---
  syncSettings(settings, themes, cosmetics) {
    const S = (id) => $(id);
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      S(`vol-${bus}`).value = Math.round((settings.audio[bus] ?? 0.5) * 100);
      S(`vol-${bus}`).nextElementSibling.textContent = `${Math.round((settings.audio[bus] ?? 0.5) * 100)}%`;
    }
    S('set-muted').checked = settings.audio.muted;
    S('set-captions').checked = settings.a11y.captions;
    S('set-haptics').checked = settings.a11y.haptics;
    S('set-tier').value = settings.graphics.tier;
    S('set-motion').checked = settings.a11y.reducedMotion;
    S('set-contrast').checked = settings.a11y.highContrast;
    S('set-text').checked = settings.a11y.largerText;
    S('set-labels').checked = settings.a11y.cellLabels;
    S('set-palette').value = settings.a11y.palette;
    S('set-lefty').checked = settings.a11y.leftHanded;
    S('set-hold').checked = settings.a11y.holdToDrag;
    S('set-timing').checked = settings.a11y.timingAssist;
    S('set-telemetry').checked = settings.telemetryConsent === true;

    const list = $('theme-list');
    list.textContent = '';
    for (const theme of themes) {
      const owned = cosmetics.unlocked.includes(theme.id);
      const b = document.createElement('button');
      b.className = 'theme-swatch';
      b.style.background = `linear-gradient(135deg, ${theme.accentA}, ${theme.accentB} 60%, ${theme.bg})`;
      b.textContent = owned ? theme.name : '🔒';
      b.title = owned ? theme.name : `${theme.name} — ${unlockHint(theme.unlock)}`;
      b.setAttribute('aria-pressed', String(cosmetics.theme === theme.id));
      b.disabled = !owned;
      b.addEventListener('click', () => this.handlers.onTheme?.(theme.id));
      list.appendChild(b);
    }
  }

  renderBindings(actions, bindings, onCapture) {
    const wrap = $('bindings-list');
    wrap.textContent = '';
    for (const action of actions) {
      const label = document.createElement('span');
      label.textContent = action.label;
      const key = document.createElement('button');
      key.className = 'bind-key';
      key.textContent = bindings[action.id] || action.def;
      key.addEventListener('click', () => {
        key.classList.add('listening');
        key.textContent = 'press key…';
        this._bindingCapture = (k) => {
          key.classList.remove('listening');
          onCapture(action.id, k);
        };
      });
      wrap.append(label, key);
    }
  }

  captureBindingKey(key) {
    if (this._bindingCapture) {
      const cb = this._bindingCapture;
      this._bindingCapture = null;
      cb(key);
      return true;
    }
    return false;
  }

  renderHelp(cards) {
    const grid = $('help-cards');
    grid.textContent = '';
    for (const c of cards) {
      const div = document.createElement('div');
      div.className = 'help-card';
      div.innerHTML = `<h3>${escapeHtml(c.title)}</h3><p>${c.body}</p>`;
      grid.appendChild(div);
    }
  }

  // ------------------------------------------------------------ overlays ---
  openPause(summary) {
    $('pause-summary').textContent = summary;
    this._lastFocus = document.activeElement;
    $('overlay-pause').hidden = false;
    $('btn-resume').focus();
  }
  closePause() {
    $('overlay-pause').hidden = true;
    this._restoreFocus();
  }
  get pauseOpen() { return !$('overlay-pause').hidden; }

  confirm(text, title = 'Are you sure?') {
    $('confirm-h').textContent = title;
    $('confirm-text').textContent = text;
    this._lastFocus = document.activeElement;
    $('overlay-confirm').hidden = false;
    $('btn-confirm-no').focus();
    return new Promise((resolve) => { this._confirmResolve = resolve; });
  }
  _resolveConfirm(v) {
    $('overlay-confirm').hidden = true;
    this._confirmResolve?.(v);
    this._confirmResolve = null;
    this._restoreFocus();
  }

  _restoreFocus() {
    if (this._lastFocus?.focus) this._lastFocus.focus({ preventScroll: true });
    this._lastFocus = null;
  }

  toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.hidden = true; }, ms);
  }

  countdown(text) {
    const el = $('countdown');
    if (text == null) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
  }

  announce(msg, assertive = false) {
    const el = $(assertive ? 'alerts' : 'live');
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = msg; });
  }

  caption(msg) {
    const el = $('captions');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._capT);
    this._capT = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ------------------------------------------------------------- drawers ---
  syncLayout() {
    const compact = window.innerWidth < 1024;
    $('btn-drawer-left').hidden = !compact || $('hud').hidden;
    $('btn-drawer-right').hidden = !compact || $('hud').hidden;
    if (!compact) this.closeDrawers();
  }

  toggleDrawer(which) {
    const drawer = $(`drawer-${which}`);
    const other = $(`drawer-${which === 'left' ? 'right' : 'left'}`);
    other.hidden = true;
    if (!drawer.hidden) { drawer.hidden = true; return; }
    // Clone rail content into the drawer (UI state only; never touches sim).
    const rail = $(which === 'left' ? 'rail-left' : 'rail-right');
    drawer.textContent = '';
    const clone = rail.cloneNode(true);
    clone.removeAttribute('id');
    clone.style.display = 'block';
    clone.style.position = 'static';
    clone.style.width = 'auto';
    clone.style.border = 'none';
    clone.style.background = 'transparent';
    clone.style.padding = '0';
    // Rewire cloned buttons by id → delegate to originals.
    clone.querySelectorAll('[id]').forEach((el) => {
      const orig = document.getElementById(el.id);
      el.removeAttribute('id');
      if (orig && el.tagName === 'BUTTON') {
        el.addEventListener('click', () => { orig.click(); this.closeDrawers(); });
      }
    });
    drawer.appendChild(clone);
    drawer.hidden = false;
    drawer.querySelector('button')?.focus();
  }

  closeDrawers() {
    $('drawer-left').hidden = true;
    $('drawer-right').hidden = true;
  }
}

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function luminance(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function unlockHint(unlock) {
  switch (unlock?.type) {
    case 'journey': return `complete ${unlock.n} journey stages`;
    case 'streak': return `reach a ${unlock.n}-day daily streak`;
    case 'stages': return `finish ${unlock.n} stages`;
    case 'cells': return `paint ${unlock.n.toLocaleString()} cells`;
    default: return 'unlock through play';
  }
}
