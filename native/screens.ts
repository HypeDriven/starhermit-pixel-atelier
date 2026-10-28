// The browser build's DOM shell (index.html, js/ui.js, styles.css) as
// starhermit:ui, built every frame over the drafting table: the menu screens
// (title, lessons, journey map, setup, results, profile, leaderboard,
// settings, how to play) as cards over the scene's veil, the play HUD (pause
// button, title and mode, the timer / moves / errors / progress pills), the
// Objective and Tools rails (wide windows) or the side drawers behind their
// tabs with the lesson strip (compact windows), the palette tray (swatches
// with number, shape and cells left; a column at the side on short
// landscape windows), the pause card, the confirmation card, the toast,
// captions and the countdown. The old media queries are layouts picked by
// the window's logical size: wide (≥ 1024 px: rails), compact (drawers),
// phone portrait (smaller pills and swatches) and short landscape
// (≤ 500 px tall: the tray as a column beside the board, at the start side
// for the left-handed layout). Rails swap sides for the left-handed layout.
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Progress, Rules, Sessions } from "./game.ts";
import { N, S, T, contentTitle, fmtTime, num } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  RESULT_REASONS, addRival, app, camReset, closeConfirm, cloudSync, copyInvite, cycleColor, doHint, doUndo, exitReplay, fresh, hudRects,
  later, leaderboardLine, leaveRound, lessonText, navBack, now, objectiveText, openHelp, openMode, openProfile, openSettings, pauseToggle,
  quickPlay, removeRival, rename, replayState, replayTutorials, resolvedPalette, restartRound, resultsNext, resultsReplay, resultsRetry,
  resumeRound, selectColor, setBoardScope, setTheme, setTool, setupRows, showBoard, showSetup, signIn, skipAnimations, startLesson, startSetup,
  togglePan, wipe, zoom, type Mode,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; landShort: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, phone: lw <= 700 && lh > lw, landShort: lh <= 500 && lw > lh };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const inner = b.width - 34;
    opts.content = () => { ui.style("wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** Buttons in rows that wrap at `width` (flex-wrap), optionally stretched across each row. */
function flow(label: string, list: Btn[], width: number, gap = 8, stretch = false, justify: "start" | "center" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      if (stretch) {
        const total = row.reduce((n, b) => n + bw(b), 0);
        const extra = (width - total - gap * (row.length - 1)) / row.length;
        for (const b of row) button({ ...b, width: bw(b) + extra });
      } else for (const b of row) button(b);
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
/** A box over a window rectangle (window px) drawn by a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, drawFn: (r: ui.Rect) => void): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: drawFn });
  });
}
/** CSS repeat(auto-fit, minmax(min, 1fr)). */
function cardGrid(id: string, count: number, w: number, min: number, gap: number, cell: (i: number, cw: number) => void): void {
  const cols = Math.max(1, Math.min(count, Math.floor((w + gap) / (min + gap))));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < count; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(count, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
function luminance(hex: string): number {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
/** Mixes two #rrggbb colors. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s: number): number => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}
const gray = (hex: string, k: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, l = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
  return mix(hex, `#${[l, l, l].map((v) => v.toString(16).padStart(2, "0")).join("")}`, k);
};

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen) menuScreen(L);
  else if (app.session) playHud(L);
  if (app.overlay === "pause") pauseCard(L);
  else if (app.overlay === "confirm") confirmCard(L);
  countdown(L);
  toastAndCaptions(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ menu screens (.screen + .menu-card)
const WIDE_SCREENS = new Set(["learn", "journey", "profile", "settings", "help"]);
function menuScreen(L: Layout): void {
  const f = frame();
  const title = app.screen === "title";
  // the veil over the table (lighter on the title, where the scene reads through)
  paint("veil", 0, 0, f.width, f.height, (r) => draw.rect(r.x, r.y, r.width, r.height, title ? "#0a10245c" : "#0a1024a6"));
  const maxW = WIDE_SCREENS.has(app.screen!) ? 860 : 480;
  const pad = L.phone ? 18 : 24;
  const cw = Math.min(maxW, L.lw - 32);
  const key = `screen-${app.screen}`;
  const prev = lastSize.get(key);
  const bodyH = L.lh - 32;
  const scroll = !!prev && prev.height / L.sc > bodyH;
  const h = prev ? prev.height / L.sc : 0;
  const opening = f.frame - app.screenFrame <= 6;
  const y = scroll ? 16 : Math.max(16, (L.lh - h) / 2);
  ui.place("screen", { anchor: "top-start", x: (L.lw - cw) / 2 - (scroll ? 7 : 0), y }, () => {
    const card = (): void => {
      const r = ui.column(`${key}-card`, () => {
        buildScreen(cw - 2 * pad - 2 - (scroll ? 14 : 0), L);
      }, { style: "menu-card", width: cw - (scroll ? 14 : 0), spacing: 12, padding: pad });
      lastSize.set(key, r);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: cw + 14, height: bodyH }, card, opening ? { scrollTo: { top: 0 } } : undefined);
    else card();
  });
}
function buildScreen(w: number, L: Layout): void {
  switch (app.screen) {
    case "title": titleScreen(w); break;
    case "learn": learnScreen(w); break;
    case "journey": journeyScreen(w); break;
    case "setup": setupScreen(w); break;
    case "results": resultsScreen(w); break;
    case "profile": profileScreen(w, L); break;
    case "board": boardScreen(w); break;
    case "settings": settingsScreen(w, L); break;
    case "help": helpScreen(w); break;
  }
}
const backBtn = (): Btn => ({ id: "btn-back", text: T("Back"), style: "btn-ghost", act: navBack });

/** .logo-mark: four 18 px squares. */
function logoMark(): void {
  ui.widget("", {
    role: "none", size: { width: 39, height: 39 }, draw: (r, st) => {
      const s = st.scale, q = 18 * s, g = 3 * s;
      const cols = [token("accent-a"), token("accent-b"), "#ffd166", token("ok")];
      cols.forEach((c, i) => draw.roundRect(r.x + (i % 2) * (q + g), r.y + Math.floor(i / 2) * (q + g), q, q, 3, c));
    },
  });
}
/** .wordmark: the title in a gradient from accent A to accent B (per glyph). */
function wordmark(text: string, w: number): void {
  const size = Math.min(38.4, w / 7);
  ui.widget(text, {
    role: "image", size: { width: w, height: size * 1.3 }, draw: (r, st) => {
      const px = size * st.scale;
      const total = draw.measureText(text, { size: px, weight: "700", letterSpacing: px * 0.02 }).width;
      const chars = [...text];
      const at = (n: number): number => (n ? draw.measureText(chars.slice(0, n).join(""), { size: px, weight: "700", letterSpacing: px * 0.02 }).width : 0);
      chars.forEach((ch, i) => {
        if (ch === " ") return;
        const x0 = at(i), x1 = at(i + 1);
        const t = Math.max(0, Math.min(1, ((x0 + x1) / 2) / Math.max(1, total)));
        draw.text(ch, r.x + x0, r.y + px * 0.08, { size: px, weight: "700", color: mix(token("accent-a"), token("accent-b"), t) });
      });
    },
  });
}

// ------------------------------------------------------------------ title
function titleScreen(w: number): void {
  const d = platform.data();
  logoMark();
  wordmark("Pixel Atelier", w);
  para(T("Paint the table. Reveal the art."), w, "tagline", "tagline");
  button({ id: "btn-play", text: T("Play"), style: "btn-big", width: w, act: quickPlay });
  const today = platform.utcDate();
  const done = d.daily.history[today];
  const cards: [string, string, string, Mode][] = [
    ["btn-daily", T("Daily Table"), done ? T("Done today · best {score}", { score: done.score }) : T("Streak {n} · new canvas", { n: d.daily.streak }), "daily"],
    ["btn-journey", T("Journey"), T("{done} / {total} stages", { done: Object.keys(d.journey.stars).length, total: Content.JOURNEY.length }), "journey"],
    ["btn-practice", T("Practice"), T("Unranked, undo allowed"), "practice"],
    ["btn-challenge", T("Challenge"), T("Constrained rulesets"), "challenge"],
    ["btn-chase", T("Score Chase"), T("Weekly ranked board"), "score-chase"],
    ["btn-learn", T("Learn"), T("{done} / {total} done", { done: d.tutorials.done.length, total: Content.LESSONS.length }), "learn"],
  ];
  cardGrid("menu-grid", cards.length, w, 130, 8, (i, cw) => {
    const [id, title, sub, mode] = cards[i]!;
    const inner = cw - 26;
    button({
      id, text: title, name: title, style: "btn-card", width: cw, act: () => openMode(mode),
      content: () => ui.column(`${id}-face`, () => { para(title, inner, "btn-title-c"); para(sub, inner, "btn-sub-c"); }, { spacing: 2, width: inner, align: "center" }),
    });
  });
  const foot: Btn[] = [
    { id: "btn-profile", text: T("Profile"), style: "btn-ghost", act: openProfile },
    { id: "btn-boards", text: T("Leaderboard"), style: "btn-ghost", act: () => showBoard("weekly") },
    { id: "btn-settings", text: T("Settings"), style: "btn-ghost", act: () => openSettings("title") },
    { id: "btn-help", text: T("How to play"), style: "btn-ghost", act: openHelp },
  ];
  if (platform.inviteLink()) foot.push({ id: "btn-invite", text: S("invite"), style: "btn-ghost", act: copyInvite });
  if (!platform.signedIn()) foot.push({ id: "btn-signin", text: S("signIn"), style: "btn-ghost", act: signIn });
  flow("title-foot", foot, w, 8);
  para(platform.signedIn() ? T("Signed in · build {build}", { build: Sessions.BUILD_VERSION })
    : T("Guest mode · build {build} · progress saved locally", { build: Sessions.BUILD_VERSION }), w, "fine", "title-note");
}

// ------------------------------------------------------------------ learn
function learnScreen(w: number): void {
  const done = platform.data().tutorials.done;
  para(T("Atelier Lessons"), w, "h2", "learn-h");
  para(T("One rule at a time. Each lesson asks you to perform the action."), w, "dim");
  ui.column("lesson-list", () => {
    Content.LESSONS.forEach((l, i) => {
      const title = `${i + 1}. ${T(l.title)}${done.includes(l.id) ? " ✓" : ""}`;
      const inner = w - 34;
      button({
        id: `lesson-${i + 1}`, text: title, name: title, style: "btn-list", width: w, act: () => startLesson(l),
        content: () => ui.column(`lesson-${i + 1}-face`, () => { para(title, inner, "btn-title"); para(T(l.intro), inner, "btn-sub"); }, { spacing: 2, width: inner }),
      });
    });
  }, { spacing: 8, width: w });
  flow("learn-foot", [backBtn()], w);
}

// ------------------------------------------------------------------ journey
function journeyScreen(w: number): void {
  const stars = platform.data().journey.stars;
  para(T("Journey"), w, "h2", "journey-h");
  para(T("Seven chapters. Every sixth stage is a mastery table."), w, "dim");
  let unlocked = true;
  Content.JOURNEY_CHAPTERS.forEach((ch, ci) => {
    const list = Content.JOURNEY.filter((s) => s.meta.chapter === ci + 1);
    para(`${ci + 1}. ${T(ch.name)}`, w, "h3", `chapter-${ci + 1}`);
    const gap = 8, cw = (w - gap * 5) / 6;
    ui.row(`chapter-${ci + 1}-row`, () => {
      list.forEach((s, si) => {
        const st = stars[s.id] ?? 0;
        const open = unlocked && (si === 0 || (stars[list[si - 1]!.id] ?? 0) > 0);
        const title = contentTitle(s.meta.title);
        const res = ui.id(`stage-${s.id}`).widget((open ? T("{title}, {n} of 3 stars", { title, n: st }) : T("{title}, {n} of 3 stars, locked", { title, n: st })), {
          role: "button", size: { width: cw, height: cw }, style: s.meta.mastery ? "cell-mastery" : "cell-btn", disabled: !open,
          draw: (r, ws) => {
            const k = ws.scale, cx = r.x + r.width / 2;
            const big = Math.max(10, Math.min(16, cw * 0.22)) * k;
            let y = r.y + r.height * 0.12;
            draw.text(s.meta.mastery ? "★" : String(si + 1), cx, y, { size: big, weight: "800", color: token("text"), align: "center" });
            y += big * 1.15;
            const sm = Math.max(8, Math.min(12.8, cw * 0.18)) * k;
            draw.text("●".repeat(st) + "○".repeat(Math.max(0, 3 - st)), cx, y, { size: sm, color: "#ffd166", align: "center", letterSpacing: k });
            y += sm * 1.2;
            const nm = Math.max(7, Math.min(9.9, cw * 0.13)) * k;
            const maxW = r.width - 8 * k;
            const lines: string[] = [];
            let line = "";
            for (const word of title.split(" ")) {
              const tryL = line ? `${line} ${word}` : word;
              if (draw.measureText(tryL, { size: nm }).width <= maxW || !line) line = tryL;
              else { lines.push(line); line = word; }
            }
            if (line) lines.push(line);
            lines.slice(0, 2).forEach((l, li) => {
              let t = l;
              while (t.length > 1 && draw.measureText(t, { size: nm }).width > maxW) t = t.slice(0, -1);
              if (t !== l || (li === 1 && lines.length > 2)) t = t.replace(/.$/, "…");
              if (y + nm * (li + 1) * 1.1 <= r.y + r.height) draw.text(t, cx, y + li * nm * 1.1, { size: nm, color: token("dim"), align: "center" });
            });
            // .stage-cell:disabled { opacity: 0.35 }
            if (!open) draw.roundRect(r.x, r.y, r.width, r.height, 10, "#0d1426a6");
          },
        });
        if (res.activated && open && fresh()) later(() => showSetup("journey", s));
      });
    }, { spacing: gap, width: w });
    const last = list[list.length - 1];
    unlocked = !!last && (stars[last.id] ?? 0) > 0;
  });
  flow("journey-foot", [backBtn()], w);
}

// ------------------------------------------------------------------ setup
function dl(id: string, rows: { k: string; v: string }[], w: number): void {
  const kw = Math.min(w * 0.45, Math.max(...rows.map((r) => textWidth(T(r.k), "dt"))) + 12);
  ui.column(id, () => {
    rows.forEach((r, i) => ui.row(`${id}-${i}`, () => {
      ui.column(`${id}-${i}-k`, () => para(T(r.k), kw - 4, "dt"), { width: kw });
      ui.column(`${id}-${i}-v`, () => para(r.v, w - kw - 12, "dd", `${id}-v${i}`), { width: w - kw - 12 });
    }, { width: w, spacing: 12 }));
  }, { width: w, spacing: 4 });
}
function selectRow(id: string, label: string, idx: number, options: string[], w: number, set: (i: number) => void): void {
  ui.column(`${id}-field`, () => {
    para(label, w, "strong", `${id}-label`);
    const pick = ui.id(id).select(label, idx, options, { width: w } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  }, { width: w, spacing: 4 });
}
function setupScreen(w: number): void {
  const s = app.setup;
  if (!s) return;
  para(s.mode === "journey" && s.content ? contentTitle(s.content.meta.title) : T(s.title), w, "h2", "setup-h");
  if (s.content) dl("setup-dl", setupRows(), w);
  if (s.note) para(T(s.note), w, "dim", "setup-note");
  if (s.countdown) para(T("Next table in {time} (platform time).", { time: fmtTime(platform.msUntilNextUtcDay()) }), w, "dim", "setup-countdown");
  if (s.mode === "practice") {
    const ids = Object.keys(Content.PRACTICE_PRESETS);
    selectRow("practice-preset", T("Difficulty"), Math.max(0, ids.indexOf(app.practicePreset)),
      ids.map((id) => `${T(Content.PRACTICE_PRESETS[id]!.label)} — ${T(Content.PRACTICE_PRESETS[id]!.blurb)}`), w, (i) => { app.practicePreset = ids[i]!; });
    para(T("Seed (inspectable)"), w, "strong", "seed-label");
    const v = ui.textField("practice-seed", app.practiceSeed, { width: w, maxChars: 40, placeholder: T("Seed (blank = random)") });
    if (v !== app.practiceSeed) app.practiceSeed = v;
  }
  if (s.mode === "challenge") {
    const ids = Object.keys(Content.CHALLENGE_TYPES);
    selectRow("challenge-type", T("Challenge"), Math.max(0, ids.indexOf(app.challengeType)),
      ids.map((id) => `${T(Content.CHALLENGE_TYPES[id]!.label)} — ${T(Content.CHALLENGE_TYPES[id]!.blurb)}`), w, (i) => { app.challengeType = ids[i]!; });
    selectRow("challenge-level", T("Level"), app.challengeLevel - 1, [T("I — small"), T("II — medium"), T("III — large")], w, (i) => { app.challengeLevel = i + 1; });
  }
  flow("setup-foot", [
    { id: "btn-setup-start", text: T(s.startLabel), style: "btn-primary", act: startSetup },
    backBtn(),
  ], w);
}

// ------------------------------------------------------------------ results
function resultsScreen(w: number): void {
  const r = app.results;
  if (!r) return;
  const f = r.final;
  para(T("Results"), w, "h2", "results-h");
  para(RESULT_REASONS[r.reason] ? T(RESULT_REASONS[r.reason]!) : r.status, w, "headline", "results-headline");
  if (r.stars > 0) para("★".repeat(r.stars) + "☆".repeat(Math.max(0, 3 - r.stars)), w, "stars", "results-stars");
  const rows: [string, string, string][] = [];
  for (const [k, v] of [[N("Cells painted"), f.base], [N("Combo bonus"), f.comboBonus], [N("Region bonus"), f.regionBonus], [N("Completion bonus"), f.completionBonus], [N("Time bonus"), f.timeBonus]] as const) {
    if (v) rows.push([T(k), `+${v}`, "td-num"]);
  }
  if (f.errorPenalty) rows.push([T("Error penalty ({n})", { n: f.errors }), `−${f.errorPenalty}`, "td-pen"]);
  if (f.hintPenalty) rows.push([T("Hints used"), `−${f.hintPenalty}`, "td-pen"]);
  ui.column("results-table", () => {
    rows.forEach(([k, v, cls], i) => ui.row(`score-${i}`, () => {
      ui.column(`score-${i}-k`, () => para(k, w - 120, "td"), { width: w - 116 });
      ui.column(`score-${i}-v`, () => ui.style(cls).id(`score-${i}-n`).label(v), { width: 84, align: "end" });
    }, { style: "score-row", width: w, spacing: 0, align: "center" }));
    ui.row("score-total", () => {
      ui.column("score-total-k", () => para(T("Total"), w - 120, "total"), { width: w - 116 });
      ui.column("score-total-v", () => ui.style("total-num").id("results-total").label(String(f.total)), { width: 84, align: "end" });
    }, { style: "score-row-last", width: w, spacing: 0, align: "center" });
  }, { width: w, spacing: 0 });
  para(T("{pct}% painted · {cells} cells · {actions} actions · best combo ×{combo} · {time}", {
    pct: f.progressPct, cells: f.correct, actions: f.actions, combo: f.bestCombo, time: fmtTime(f.elapsedMs),
  }), w, "dim", "results-progress");
  if (r.achievements.length) {
    flowBadges(r.achievements.map((a) => `🏅 ${T(a.name)}`), w);
  }
  const lb = leaderboardLine();
  if (lb) para(lb, w, "dim", "results-lb");
  if (r.board) {
    para(T("Local board: #{rank} of {total}", { rank: r.board.rank, total: r.board.total }) + (r.board.ranked ? " · " + T("casual (no validated board here)") : ""), w, "dim", "results-board");
  }
  if (app.content) para(T("Seed {seed} · content v{version}", { seed: app.content.seed, version: app.content.version }), w, "fine", "results-seed");
  const btns: Btn[] = [];
  if (r.canNext) btns.push({ id: "btn-results-next", text: T(r.nextLabel), style: "btn-primary", act: resultsNext });
  btns.push(
    { id: "btn-results-retry", text: T("Retry"), act: resultsRetry },
    { id: "btn-results-replay", text: T("Watch replay"), style: "btn-ghost", act: resultsReplay },
    { id: "btn-results-board", text: T("Leaderboard"), style: "btn-ghost", act: () => showBoard("round") },
    { id: "btn-results-home", text: T("Home"), style: "btn-ghost", act: navBack },
  );
  flow("results-btns", btns, w);
}
function flowBadges(list: string[], w: number): void {
  const rows: string[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = textWidth(b, "badge-text") + 26;
    if (rows[rows.length - 1]!.length && used + 6 + bw > w) { rows.push([]); used = 0; }
    used += bw + 6;
    rows[rows.length - 1]!.push(b);
  }
  ui.column("ach-row", () => rows.forEach((row, ri) => ui.row(`ach-row-${ri}`, () => {
    row.forEach((b, i) => ui.row(`ach-${ri}-${i}`, () => ui.style("badge-text").label(b), { style: "ach-badge" }));
  }, { spacing: 6 })), { spacing: 6, width: w });
}

// ------------------------------------------------------------------ profile
let nameDraft: string | null = null;
let rivalDraft = "";
function profileScreen(w: number, L: Layout): void {
  const d = platform.data();
  para(T("Profile"), w, "h2", "profile-h");
  const two = !L.phone && w >= 600;
  const colW = two ? (w - 20) / 2 : w;
  const left = (): unknown => ui.column("profile-left", () => {
    para(T("Display name"), colW, "strong", "name-label");
    const cur = nameDraft ?? d.profile.name;
    const v = ui.textField("profile-name", cur, { width: colW, maxChars: 24, placeholder: T("Display name") });
    if (v !== cur) nameDraft = v;
    if (ui.submitted("profile-name") || (nameDraft !== null && ui.focused() !== "profile-name")) {
      const n = nameDraft;
      nameDraft = null;
      if (n !== null) later(() => rename(n));
    }
    para(platform.signedIn() ? T("Signed in through the host shell. Progress syncs to the cloud.") : T("Guest profile — progress is stored on this device."), colW, "dim", "profile-identity");
    if (platform.signedIn()) {
      const st = platform.syncState();
      para(st === "synced" ? T("Cloud save: synced.") : st === "saving" ? T("Cloud save: saving…") : T("Cloud save: offline — local copy kept."), colW, "fine", "profile-sync");
    }
    const mins = Math.round(d.stats.playtimeMs / 60000);
    dl("profile-stats", [
      { k: N("Cells painted"), v: num(d.stats.cellsFilled) },
      { k: N("Rounds completed"), v: String(d.stats.roundsCompleted) },
      { k: N("Sessions"), v: String(d.stats.sessions) },
      { k: N("Playtime"), v: mins >= 1 ? T("{n} min", { n: mins }) : T("<1 min") },
      { k: N("Daily streak"), v: (d.daily.streak === 1 ? T("{n} day", { n: d.daily.streak }) : T("{n} days", { n: d.daily.streak })) },
    ], colW);
  }, { width: colW, spacing: 8 });
  const right = (): unknown => ui.column("profile-right", () => {
    para(T("Achievements"), colW, "h3", "ach-h");
    for (const a of Progress.ACHIEVEMENTS) {
      const at = d.achievements[a.key];
      ui.column(`ach-${a.key}`, () => {
        para(`${at ? "🏅" : "○"} ${T(a.name)}`, colW, at ? "ach-key" : "dim", `ach-${a.key}-name`);
        para(T(a.desc), colW, "dim", `ach-${a.key}-desc`);
        if (at) para(new Date(at).toISOString().slice(0, 10), colW, "ach-when");
      }, { width: colW, spacing: 2 });
    }
  }, { width: colW, spacing: 8 });
  if (two) ui.row("profile-grid", () => { left(); right(); }, { spacing: 20, width: w, align: "start" });
  else { left(); right(); }
  para(`${T("Rivals")} ${T("(local score comparison)")}`, w, "h3", "rivals-h");
  ui.row("rival-add", () => {
    const bw = buttonWidth(T("Add rival"), "btn");
    const v = ui.textField("rival-name", rivalDraft, { width: w - bw - 8, maxChars: 24, placeholder: T("Rival name") });
    if (v !== rivalDraft) rivalDraft = v;
    const add = (): void => { const n = rivalDraft.trim(); rivalDraft = ""; if (n) addRival(n); };
    if (ui.submitted("rival-name") && fresh()) later(add);
    button({ id: "btn-add-rival", text: T("Add rival"), act: add });
  }, { width: w, spacing: 8, align: "center" });
  ui.column("rival-list", () => {
    if (!d.rivals.length) ui.column("rival-empty", () => para(T("No rivals yet — add one to compare scores locally."), w - 30, "dim"), { style: "list-card", width: w });
    d.rivals.forEach((r, i) => ui.row(`rival-${i}`, () => {
      const bw = buttonWidth(T("Remove"), "btn-ghost");
      ui.column(`rival-${i}-t`, () => { para(r.name, w - bw - 60, "text"); para(T("best {score}", { score: r.best ?? 0 }), w - bw - 60, "dim"); }, { width: w - bw - 46 });
      button({ id: `rival-${i}-remove`, text: T("Remove"), style: "btn-ghost", act: () => removeRival(r.name) });
    }, { style: "list-card", width: w, align: "center", spacing: 8 }));
  }, { width: w, spacing: 8 });
  const foot: Btn[] = [];
  if (platform.signedIn()) foot.push({ id: "btn-cloud-sync", text: T("Sync cloud save"), style: "btn-ghost", act: cloudSync });
  foot.push(backBtn());
  flow("profile-foot", foot, w);
}

// ------------------------------------------------------------------ leaderboard
function boardScreen(w: number): void {
  const b = app.board;
  para(T("Leaderboard"), w, "h2", "board-h");
  para(b.label(), w, "dim", "board-sub");
  flow("board-tabs", [
    { id: "board-tab-global", text: T("Global"), style: "chip", selected: b.scope === "global", act: () => setBoardScope("global") },
    { id: "board-tab-friends", text: T("Friends"), style: "chip", selected: b.scope === "friends", act: () => setBoardScope("friends") },
  ], w);
  const me = platform.data().profile.name;
  ui.column("board-list", () => {
    if (b.entries === null) para(T("Loading…"), w, "dim", "board-loading");
    else if (!b.entries.length) para(T("No scores yet — be the first."), w, "dim", "board-empty");
    else b.entries.slice(0, 20).forEach((e, i) => ui.row(`board-${i}`, () => {
      ui.column(`board-${i}-n`, () => ui.style("dim").label(`${i + 1}.`), { width: 32 });
      ui.column(`board-${i}-t`, () => para(T("{name} — {score} ({pct}%, {errors} errors, {time})", {
        name: e.name, score: e.score, pct: Math.round(e.progressPct), errors: e.errors, time: fmtTime(e.elapsedMs),
      }), w - 52, e.name === me ? "me" : "text"), { width: w - 40 });
    }, { style: "board-row", width: w, spacing: 0 }));
  }, { width: w, spacing: 0 });
  if (b.note) para(T(b.note), w, "fine", "board-note");
  flow("board-foot", [backBtn()], w);
}

// ------------------------------------------------------------------ settings
/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent-a") : token("field"));
        draw.strokeRoundRect(bx, by, box, box, 4, token("edge"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#04121a", align: "center", weight: "bold" });
      },
    });
    para(T(label), w - 56, "strong", `${id}-label`);
    if (res.activated && fresh()) later(() => set(!on));
  }, { width: w, align: "center", spacing: 8 });
}
function fieldset(id: string, legend: string, w: number, build: (iw: number) => void): void {
  ui.column(id, () => {
    para(legend, w - 34, "legend", `${id}-legend`);
    build(w - 34);
  }, { style: "fieldset", width: w, spacing: 6 });
}
function settingsScreen(w: number, L: Layout): void {
  const o = platform.options;
  para(T("Settings"), w, "h2", "settings-h");
  const cols = !L.phone && w >= 520 ? 2 : 1;
  const fw = (w - (cols - 1) * 16) / cols;
  const sets: (() => void)[] = [
    () => fieldset("fs-audio", T("Audio"), fw, (iw) => {
      para(T("Volumes, mute, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), iw, "dim", "options-note");
      flow("fs-audio-btns", [{ id: "btn-options", text: T("Open Options"), act: () => openMenu() }], iw);
      toggleRow("set-captions", N("Captions for audio cues"), o.captions, iw, (v) => platform.setOption("captions", v));
      toggleRow("set-haptics", N("Haptics (vibration)"), o.haptics, iw, (v) => platform.setOption("haptics", v));
    }),
    () => fieldset("fs-display", T("Display & accessibility"), fw, (iw) => {
      toggleRow("set-labels", N("Always show cell numbers"), o.cellLabels, iw, (v) => platform.setOption("cellLabels", v));
      const pals = ["default", "contrast", "cvd"] as const;
      selectRow("set-palette", T("Cell palette"), Math.max(0, pals.indexOf(o.palette)), [T("Artwork colors"), T("Vivid contrast"), T("Color-vision safe")], iw,
        (i) => platform.setOption("palette", pals[i]!));
    }),
    () => fieldset("fs-controls", T("Controls"), fw, (iw) => {
      toggleRow("set-lefty", N("Left-handed layout"), o.leftHanded, iw, (v) => platform.setOption("leftHanded", v));
      toggleRow("set-hold", N("Hold to paint (off = toggle)"), o.holdToDrag, iw, (v) => platform.setOption("holdToDrag", v));
      toggleRow("set-timing", N("Timing assistance (+50% time)"), o.timingAssist, iw, (v) => platform.setOption("timingAssist", v));
      flow("fs-controls-btns", [{ id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() }], iw);
      para(T("Gamepad: D-pad moves the cursor, A paints, B pauses, X undoes, Y hints, shoulders cycle colors, triggers zoom, the left stick pans, Start pauses."), iw, "fine", "pad-note");
    }),
    () => fieldset("fs-theme", T("Theme (cosmetic)"), fw, (iw) => {
      const d = platform.data();
      const size = 64, gap = 8;
      const per = Math.max(1, Math.floor((iw + gap) / (size + gap)));
      ui.column("theme-list", () => {
        for (let r = 0; r * per < Content.THEMES.length; r++) {
          ui.row(`theme-row-${r}`, () => {
            for (const th of Content.THEMES.slice(r * per, (r + 1) * per)) {
              const owned = d.cosmetics.unlocked.includes(th.id);
              const chosen = d.cosmetics.theme === th.id;
              const res = ui.id(`theme-${th.id}`).widget(owned ? T(th.name) : `${T(th.name)} — ${unlockHint(th.unlock)}`, {
                role: "toggle", checked: chosen, disabled: !owned, size: { width: size, height: size },
                draw: (rr, st) => {
                  const k = st.scale;
                  draw.box(rr.x, rr.y, rr.width, rr.height, {
                    background: { type: "linear", angle: 135, stops: [th.accentA, { color: th.accentB, at: 0.6 }, th.bg] },
                    radius: 10, border: { width: 2, color: chosen ? token("accent-a") : token("edge") },
                  });
                  if (!owned) draw.rect(rr.x, rr.y, rr.width, rr.height, "#05070f99");
                  const label = owned ? T(th.name) : "🔒";
                  const sz = 9.9 * k;
                  const words = label.split(" ");
                  words.slice(-2).forEach((wd, wi, arr) => draw.text(wd, rr.x + 6 * k, rr.y + rr.height - (arr.length - wi) * sz * 1.15 - 4 * k,
                    { size: sz, weight: "700", color: "#ffffff", shadow: { color: "#000000", x: 0, y: k } }));
                },
              });
              if (res.activated && owned && fresh()) later(() => setTheme(th.id));
            }
          }, { spacing: gap });
        }
      }, { spacing: gap, width: iw });
      para(T("Themes change only materials and ambience — never gameplay."), iw, "fine");
      para(T("Privacy"), iw, "h3");
      flow("fs-privacy", [
        { id: "btn-replay-tutorials", text: T("Replay tutorials"), style: "btn-ghost", act: replayTutorials },
        { id: "btn-wipe", text: T("Erase local data"), style: "btn-danger", act: wipe },
      ], iw);
    }),
  ];
  if (cols === 1) for (const s of sets) s();
  else {
    for (let i = 0; i < sets.length; i += 2) ui.row(`settings-row-${i}`, () => { sets[i]!(); sets[i + 1]?.(); }, { spacing: 16, width: w, align: "start" });
  }
  flow("settings-foot", [backBtn()], w);
}
function unlockHint(u: { type: string; n?: number }): string {
  switch (u.type) {
    case "journey": return T("complete {n} journey stages", { n: u.n ?? 0 });
    case "streak": return T("reach a {n}-day daily streak", { n: u.n ?? 0 });
    case "stages": return T("finish {n} stages", { n: u.n ?? 0 });
    case "cells": return T("paint {n} cells", { n: num(u.n ?? 0) });
    default: return T("unlock through play");
  }
}

// ------------------------------------------------------------------ help
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
function keyOf(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join(" / ") || "—";
}
function helpScreen(w: number): void {
  para(T("How to play"), w, "h2", "help-h");
  const k = (a: string): string => `[${keyOf(a)}]`;
  const cards: [string, string][] = [
    [T("Goal"), T("Every cell hides a target color. Fill the whole canvas to reveal the artwork. The palette shows how many cells each color still needs.")],
    [T("Paint"), T("Select a swatch, then click or drag across glowing cells. Keyboard: {up} {left} {down} {right} move the cursor, {fill} paints, number keys pick swatches. Drag only lands where the color belongs.",
      { up: k("cursor_up"), left: k("cursor_left"), down: k("cursor_down"), right: k("cursor_right"), fill: k("fill") })],
    [T("Region tool"), T("Press {key} or the Region button, then click a shape to flood every connected cell of that color. It only fills cells matching your selected color.", { key: k("region_tool") })],
    [T("Camera"), T("Wheel or pinch to zoom, right-drag or Pan mode to move, {key} to refit. On touch, two fingers pan and pinch.", { key: k("cam_reset") })],
    [T("Hints & undo"), T("{hint} highlights a legal cell (small score cost). {undo} reverts your last fill where the ruleset allows it.", { hint: k("hint"), undo: k("undo") })],
    [T("Rulesets"), T("Challenges change the contract: move limits, time limits, locked color order, or errors that count. The setup screen always shows the rules before you commit.")],
    [T("Scoring"), T("Cells ×10, rising combo bonus, region and completion bonuses, time bonus under par. Errors and hints cost points. Ties break on completion, errors, then time.")],
    [T("Access"), T("Numbers, shapes and labels reinforce color. Reduced motion, high contrast, color-vision palettes, larger text and left-handed layout live in Settings.")],
  ];
  cardGrid("help-cards", cards.length, w, 220, 12, (i, cw) => {
    const [t, b] = cards[i]!;
    ui.column(`help-${i}`, () => { para(t, cw - 30, "h3"); para(b, cw - 30, "text"); }, { style: "help-card", width: cw, spacing: 6 });
  });
  flow("help-foot", [backBtn()], w);
}

// ------------------------------------------------------------------ the play HUD
const SHAPES = ["●", "◆", "■", "▲", "★", "✚", "◐", "⬟"];
function playHud(L: Layout): void {
  const s = app.session!;
  const rs = replayState();
  const st = rs ?? s.state;
  const c = app.content!;
  const left = platform.options.leftHanded;
  const pad = 12;
  // top bar (.hud-top)
  const top = ui.place("hud-top-l", { anchor: "top-start", x: pad, y: L.landShort ? 4 : 8 }, () => {
    ui.row("hud-group", () => {
      const r = ui.style("icon-btn", { width: 44, height: 44 }).id("btn-hud-pause").widget(T("Pause"), {
        role: "button", size: { width: 44, height: 44 },
        draw: (rr, ws) => {
          const k = ws.scale, bw = 4 * k, bh = 16 * k, cx = rr.x + rr.width / 2, cy = rr.y + rr.height / 2;
          draw.rect(cx - 6 * k, cy - bh / 2, bw, bh, token("text"));
          draw.rect(cx + 2 * k, cy - bh / 2, bw, bh, token("text"));
        },
      });
      if (r.activated && fresh()) later(() => (app.replay ? exitReplay() : pauseToggle()));
      ui.column("hud-objective", () => {
        para(contentTitle(c.meta.title), Math.min(360, L.lw * 0.45), L.phone ? "hud-title-sm" : "hud-title", "hud-title");
        ui.style("hud-mode").id("hud-mode").label(T(`mode.${app.mode}`).toUpperCase());
      }, { spacing: 0 });
    }, { spacing: 8, align: "center" });
  });
  rect(top);
  const pills: [string, string, string][] = [];
  const r = st.ruleset;
  const total = st.w * st.h;
  if (st.status === "active" || st.status === "paused" || rs) {
    if (r.timeLimitMs != null) {
      const leftMs = Math.max(0, r.timeLimitMs - st.elapsedMs);
      pills.push(["hud-timer", fmtTime(leftMs), leftMs < 15000 ? "warn" : ""]);
    } else pills.push(["hud-timer", fmtTime(st.elapsedMs), ""]);
  }
  if (r.moveLimit != null) pills.push(["hud-moves", String(Math.max(0, r.moveLimit - st.stats.actions)), r.moveLimit - st.stats.actions <= Math.ceil(total * 0.08) ? "warn" : ""]);
  if (!r.errorPrevention || r.errorLimit != null) pills.push(["hud-errors", `${st.stats.errors}${r.errorLimit ? `/${r.errorLimit}` : ""}`, "danger"]);
  pills.push(["hud-progress", `${Math.floor((st.stats.correct / total) * 100)}%`, ""]);
  const status = ui.place("hud-top-r", { anchor: "top-end", x: pad, y: L.landShort ? 4 : 8 }, () => {
    ui.row("hud-status", () => {
      for (const [id, text, kind] of pills) {
        const box = L.phone ? "hud-pill-sm" : kind === "warn" ? "hud-pill-warn" : kind === "danger" ? "hud-pill-danger" : "hud-pill";
        ui.row(id, () => ui.style(kind === "warn" ? "pill-text-warn" : kind === "danger" ? "pill-text-danger" : "pill-text").id(`${id}-text`).label(text), { style: box, align: "center" });
      }
    }, { spacing: 8, align: "center" });
  });
  rect(status);
  const lesson = lessonText();
  const railTop = L.landShort ? 56 : 70, railBottom = L.landShort ? 12 : 110;
  const railH = Math.max(120, L.lh - railTop - railBottom);
  if (L.wide) {
    const lx = left ? L.lw - pad - 210 : pad, rx = left ? pad : L.lw - pad - 210;
    rect(ui.place("rail-left", { anchor: "top-start", x: lx, y: railTop }, () => railBox("rail-left-box", railH, (w) => objectiveRail(w, lesson))));
    rect(ui.place("rail-right", { anchor: "top-start", x: rx, y: railTop }, () => railBox("rail-right-box", railH, (w) => toolsRail(w))));
  } else {
    // .lesson-strip under the HUD; drawers behind the ◧ / ◨ tabs
    if (lesson && !app.drawer) {
      const sw = Math.min(L.lw * 0.92, 544);
      rect(ui.place("lesson-strip", { anchor: "top", y: L.landShort ? 52 : 60 }, () => {
        ui.column("lesson-strip-box", () => para(lesson.text, sw - 26, "strip-text", "lesson-strip-text"), { style: "lesson-strip", width: sw, align: "center" });
      }));
    }
    const tabY = L.lh / 2 - 35;
    const tl = ui.place("drawer-tab-l", { anchor: "top-start", x: 0, y: tabY }, () => {
      button({ id: "btn-drawer-left", text: "◧", name: T("Open objective panel"), style: "drawer-tab-left", width: 44, height: 70, act: () => { app.drawer = app.drawer === "left" ? null : "left"; } });
    });
    const tr = ui.place("drawer-tab-r", { anchor: "top-end", x: 0, y: tabY }, () => {
      button({ id: "btn-drawer-right", text: "◨", name: T("Open tools panel"), style: "drawer-tab-right", width: 44, height: 70, act: () => { app.drawer = app.drawer === "right" ? null : "right"; } });
    });
    rect(tl); rect(tr);
    if (app.drawer) {
      const dw = Math.min(300, L.lw * 0.84);
      const which = app.drawer;
      const at = which === "left" ? { anchor: "top-start" as const, x: pad, y: railTop } : { anchor: "top-end" as const, x: pad, y: railTop };
      rect(ui.place("drawer", at, () => railBox("drawer-box", railH, (w) => (which === "left" ? objectiveRail(w, lesson) : toolsRail(w, true)), "drawer", dw)));
    }
  }
  if (!rs) tray(L, st);
}
/** A .rail panel; its content scrolls when taller. */
function railBox(id: string, h: number, build: (inner: number) => void, style = "rail", w = 210): void {
  ui.column(id, () => {
    const prev = lastSize.get(`${id}-in`);
    const inner = h - 28;
    const scroll = !!prev && prev.height / ui.preferences().scale > inner + 1;
    const iw = w - 30 - (scroll ? 14 : 0);
    const body = (): void => { lastSize.set(`${id}-in`, ui.column(`${id}-in`, () => build(iw), { spacing: 10, width: iw })); };
    if (scroll) ui.scrollArea(`${id}-scroll`, { width: w - 28, height: inner }, body);
    else body();
  }, { style, width: w, height: h, spacing: 0, padding: 14 });
}
function objectiveRail(w: number, lesson: { title: string; text: string } | null): void {
  const s = app.session!, st = s.state, c = app.content!;
  const total = st.w * st.h;
  const pct = Math.floor((st.stats.correct / total) * 100);
  para(T("Objective").toUpperCase(), w, "rail-h", "objective-h");
  para(objectiveText(c), w, "text", "objective-text");
  ui.id("progress-bar").widget(T("Canvas progress"), {
    role: "meter", value: pct, min: 0, max: 100, size: { width: w, height: 10 },
    draw: (r, ws) => {
      const k = ws.scale;
      draw.roundRect(r.x, r.y, r.width, r.height, 5, token("field"));
      draw.strokeRoundRect(r.x, r.y, r.width, r.height, 5, token("edge"), 1);
      const fw = r.width * pct / 100;
      if (fw > 1) draw.box(r.x, r.y, fw, r.height, { background: { type: "linear", angle: 90, stops: [token("accent-a"), token("accent-b")] }, radius: 5 });
      void k;
    },
  });
  para(T("{done} / {total} cells", { done: st.stats.correct, total }), w, "dim", "progress-detail");
  if (app.combo >= 4) para(T("Combo ×{n}", { n: app.combo }), w, "combo", "combo-text");
  if (lesson) {
    ui.column("lesson-box", () => {
      para(lesson.title, w - 26, "lesson-title", "lesson-title");
      para(lesson.text, w - 26, "lesson-text", "lesson-text");
    }, { style: "lesson-box", width: w, spacing: 4 });
  }
}
function toolsRail(w: number, drawer = false): void {
  const s = app.session!, st = s.state;
  const la = Rules.legalActions(st);
  const close = (fn: () => void): (() => void) => () => { fn(); if (drawer) app.drawer = null; };
  para(T("Tools").toUpperCase(), w, "rail-h", "tools-h");
  const tool = (id: string, name: string, key: string, sel: boolean | undefined, act: () => void, disabled = false): Btn => ({
    id, text: name, name, style: sel === undefined ? "btn" : "tool", selected: sel, width: w, act: close(act), disabled,
    content: () => ui.column(`${id}-face`, () => {
      ui.style("btn-title-c").label(name);
      if (key) ui.row(`${id}-kbd`, () => ui.style("kbd").label(key), { style: "kbd-box" });
    }, { spacing: 2, align: "center", width: w - 34 }),
  });
  const k = (a: string): string => keyOf(a);
  const items: Btn[] = [
    tool("tool-brush", T("Brush"), k("brush_tool"), app.tool === "brush", () => setTool("brush")),
    tool("tool-region", T("Region"), k("region_tool"), app.tool === "region", () => setTool("region"), !st.ruleset.tools.region),
    tool("btn-undo", T("Undo"), k("undo"), undefined, doUndo, !la.canUndo),
    tool("btn-hint", T("Hint"), k("hint"), undefined, doHint, !la.canHint),
    { id: "btn-zoom-in", text: "+", name: T("Zoom in"), width: w, act: close(() => zoom(0.8)) },
    { id: "btn-zoom-out", text: "−", name: T("Zoom out"), width: w, act: close(() => zoom(1.25)) },
    tool("btn-cam-reset", T("Fit"), k("cam_reset"), undefined, camReset),
    { id: "btn-pan-mode", text: T("Pan"), style: "tool", selected: app.panMode, width: w, act: close(togglePan) },
  ];
  ui.column("tool-col", () => { for (const b of items) button(b); }, { spacing: 6, width: w });
}
/** .tray > .palette: the swatches (radio group); a column beside the board on short landscape windows. */
function tray(L: Layout, st: ReturnType<typeof replayState> & object): void {
  const pal = resolvedPalette();
  const remaining: number[] = pal.map(() => 0), totals: number[] = pal.map(() => 0);
  for (let i = 0; i < st.targets.length; i++) {
    const t = st.targets[i]!;
    totals[t] = (totals[t] ?? 0) + 1;
    if (!st.filled[i]) remaining[t] = (remaining[t] ?? 0) + 1;
  }
  const vertical = L.landShort;
  const sw = vertical ? 52 : L.phone ? 46 : 52, sh = vertical ? 46 : L.phone ? 54 : 60;
  const gap = 8;
  const n = pal.length;
  const locked = st.ruleset.sequence ? st.seqColor : null;
  const swatches = (): void => {
    pal.forEach((hex, idx) => {
      const left = remaining[idx] ?? 0, tot = totals[idx] ?? 0;
      const name = idx === 0 ? T("Color background, {left} of {total} cells left", { left, total: tot }) : T("Color {n}, {left} of {total} cells left", { n: idx, left, total: tot });
      const sel = idx === st.selected;
      const done = left === 0 && tot > 0;
      const isLocked = locked != null && idx !== locked;
      const res = ui.id(`swatch-${idx}`).widget(name, {
        role: "radio", checked: sel, size: { width: sw, height: sh },
        draw: (r, ws) => {
          const k = ws.scale;
          const fill = isLocked ? gray(hex, 0.8) : hex;
          const a = done ? 0.35 : 1;
          const alpha = (c: string): string => c + Math.round(a * 255).toString(16).padStart(2, "0");
          if (sel) draw.roundRect(r.x - 3 * k, r.y - 3 * k, r.width + 6 * k, r.height + 6 * k, 13, token("accent-a"));
          draw.roundRect(r.x, r.y, r.width, r.height, 10, alpha(sel ? "#ffffff" : token("edge")));
          draw.roundRect(r.x + 2 * k, r.y + 2 * k, r.width - 4 * k, r.height - 4 * k, 8, alpha(fill));
          const lum = luminance(fill);
          const tc = alpha(lum > 0.55 ? "#101828" : "#ffffff");
          const shadow = lum > 0.55 ? undefined : { color: alpha("#000000"), x: 0, y: k };
          const cx = r.x + r.width / 2;
          const big = 16 * k, mid = 11.2 * k, sm = 9.9 * k;
          const h3 = big + mid + sm + 2 * k;
          let y = r.y + (r.height - h3) / 2 - 1 * k;
          draw.text(idx === 0 ? "•" : String(idx), cx, y, { size: big, weight: "800", color: tc, align: "center", ...(shadow ? { shadow } : {}) });
          y += big;
          draw.text(SHAPES[idx % SHAPES.length]!, cx, y, { size: mid, color: tc, align: "center", ...(shadow ? { shadow } : {}) });
          y += mid + 2 * k;
          draw.text(String(left), cx, y, { size: sm, weight: "600", color: tc, align: "center", ...(shadow ? { shadow } : {}) });
        },
      });
      if (res.activated && fresh() && !app.replay) later(() => selectColor(idx));
    });
  };
  const innerLen = n * (vertical ? sh : sw) + (n - 1) * gap;
  if (vertical) {
    const maxH = L.lh - 90;
    const h = Math.min(innerLen, maxH);
    const at = platform.options.leftHanded ? { anchor: "top-start" as const, x: 52, y: Math.max(52, L.lh - 8 - h - 22) } : { anchor: "top-end" as const, x: 52, y: Math.max(52, L.lh - 8 - h - 22) };
    rect(ui.place("tray", at, () => {
      ui.column("palette", () => {
        const body = (): void => { ui.column("palette-col", swatches, { spacing: gap, role: "radiogroup" }); };
        if (innerLen > maxH) ui.scrollArea("palette-scroll", { width: sw + 18, height: h }, body);
        else body();
      }, { style: "palette", padding: 10 });
    }));
  } else {
    const maxW = L.lw - 24;
    const w = Math.min(innerLen, maxW - 22);
    rect(ui.place("tray", { anchor: "bottom", y: 10 }, () => {
      ui.column("palette", () => {
        const body = (): void => { ui.row("palette-row", swatches, { spacing: gap, role: "radiogroup" }); };
        if (innerLen > maxW - 22) ui.scrollArea("palette-scroll", { width: w, height: sh + 18 }, body);
        else body();
      }, { style: "palette", padding: 10 });
    }));
  }
  void cycleColor;
}

// ------------------------------------------------------------------ overlays
function pauseCard(L: Layout): void {
  const w = Math.min(380, L.lw - 32), inner = w - 50;
  const open = ui.dialog(T("Paused"), "", true, () => {
    ui.column("pause-card", () => {
      para(T("Paused"), inner, "h2", "pause-h");
      para(app.pauseSummary(), inner, "dim", "pause-summary");
      button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", width: inner, act: resumeRound });
      button({ id: "btn-pause-settings", text: T("Settings"), width: inner, act: () => openSettings("pause") });
      button({ id: "btn-skip-anim", text: T("Skip animations"), style: "btn-ghost", width: inner, act: skipAnimations });
      button({ id: "btn-restart-round", text: T("Restart round"), style: "btn-ghost", width: inner, act: restartRound });
      button({ id: "btn-leave-round", text: T("Leave round"), style: "btn-danger", width: inner, act: leaveRound });
    }, { style: "overlay-card", width: w, spacing: 8, padding: L.phone ? 18 : 24 });
  });
  if (!open && fresh()) later(resumeRound);
}
function confirmCard(L: Layout): void {
  const c = app.confirm;
  if (!c) return;
  const w = Math.min(380, L.lw - 32), inner = w - 50;
  const open = ui.dialog(c.title, "", true, () => {
    ui.column("confirm-card", () => {
      para(c.title, inner, "h2", "confirm-h");
      para(c.text, inner, "dim", "confirm-text");
      flow("confirm-btns", [
        { id: "btn-confirm-yes", text: T("Confirm"), style: "btn-danger", act: () => closeConfirm(true) },
        { id: "btn-confirm-no", text: T("Cancel"), act: () => closeConfirm(false) },
      ], inner);
    }, { style: "overlay-card", width: w, spacing: 10, padding: L.phone ? 18 : 24 });
  });
  if (!open && fresh()) later(() => closeConfirm(false));
}
function countdown(L: Layout): void {
  if (!app.countdown) return;
  const text = app.countdown === "Go!" ? T("Go!") : app.countdown;
  const cls = L.lw < 500 || L.lh < 500 ? "countdown-sm" : "countdown";
  ui.place("countdown", "center", () => { ui.style(cls).id("countdown-text").label(text); });
  if (text !== lastCount) { lastCount = text; ui.announce(text, { politeness: "assertive" }); }
}
let lastCount = "";
function toastAndCaptions(L: Layout): void {
  const max = Math.min(L.lw * 0.9, 640);
  if (app.toast) {
    const t = app.toast.text;
    rect(ui.place("toast", { anchor: "bottom", y: app.screen ? 24 : 96 }, () => {
      ui.column("toast-box", () => para(t, max - 44, "toast-text", "toast-text"), { style: "toast", align: "center" });
    }));
  }
  if (app.caption && !app.screen) {
    const t = app.caption.text;
    ui.place("captions", { anchor: "bottom", y: 150 }, () => {
      ui.column("caption-box", () => para(t, max - 30, "caption-text", "caption-text"), { style: "captions", align: "center" });
    });
  }
  void now;
}
void Rules;
