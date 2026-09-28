// gfx-panel.js — the Settings screen's Graphics section: quality preset,
// render scale, per-effect overrides, adaptive resolution, frame-rate readout
// and a live cost summary. Strings are localized here (the rest of the game
// is English-only); the locale comes from navigator.language.

import { PRESETS, CATEGORIES, SHADOW_MAP, presetTier, resolve } from './gfx.js';

const EN = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
  low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device — rendering without it.',
  unknownGpu: 'unknown GPU',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
    reflections: 'Reflections', particles: 'Particles', background: 'Background motion', detail: 'Scene detail',
  },
  tier: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
  },
  sum: {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing',
  },
};

const merge = (base, over) => ({
  ...base, ...over,
  cat: { ...base.cat, ...(over.cat || {}) },
  tier: { ...base.tier, ...(over.tier || {}) },
  sum: { ...base.sum, ...(over.sum || {}) },
});

const ES = merge(EN, {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
  low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
  renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptable', showFps: 'Mostrar fotogramas por segundo',
  postUnavailable: 'El posprocesado no está disponible en este dispositivo; se renderiza sin él.',
  unknownGpu: 'GPU desconocida',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
    reflections: 'Reflejos', particles: 'Partículas', background: 'Movimiento del fondo', detail: 'Detalle de la escena',
  },
  tier: {
    off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto',
    static: 'Estático', animated: 'Animado', plain: 'Sencillo', detailed: 'Detallado',
  },
  sum: {
    noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoFull: 'oclusión ambiental completa',
    bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin suavizado',
  },
});

const STRINGS = {
  'en-US': EN,
  'en-GB': merge(EN, { cat: { grade: 'Colour grade' } }),
  'es-419': ES,
  'es-ES': merge(ES, { renderScale: 'Escala de renderizado', showFps: 'Mostrar imágenes por segundo' }),
  'de-DE': merge(EN, {
    graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
    renderScale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar – es wird ohne sie gerendert.',
    unknownGpu: 'unbekannte GPU',
    cat: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
      reflections: 'Spiegelungen', particles: 'Partikel', background: 'Hintergrundbewegung', detail: 'Szenendetails',
    },
    tier: {
      off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
      static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert',
    },
    sum: {
      noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoFull: 'volle Umgebungsverdeckung',
      bloom: 'Leuchten', reflections: 'Spiegelungen', noAa: 'keine Kantenglättung',
    },
  }),
  'fr-FR': null, 'fr-CA': null,
  'pt-BR': merge(EN, {
    graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postUnavailable: 'O pós-processamento não está disponível neste dispositivo; renderizando sem ele.',
    unknownGpu: 'GPU desconhecida',
    cat: {
      shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento',
      reflections: 'Reflexos', particles: 'Partículas', background: 'Movimento do fundo', detail: 'Detalhe da cena',
    },
    tier: {
      off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto',
      static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
    },
    sum: {
      noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoFull: 'oclusão ambiente completa',
      bloom: 'brilho', reflections: 'reflexos', noAa: 'sem antisserrilhamento',
    },
  }),
  'it-IT': merge(EN, {
    graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
    renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame rate',
    postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo: rendering senza.',
    unknownGpu: 'GPU sconosciuta',
    cat: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
      reflections: 'Riflessi', particles: 'Particelle', background: 'Movimento dello sfondo', detail: 'Dettaglio scena',
    },
    tier: {
      off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto',
      static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
    },
    sum: {
      noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoFull: 'occlusione ambientale completa',
      bloom: 'bagliore', reflections: 'riflessi', noAa: 'senza antialiasing',
    },
  }),
};
const FR = merge(EN, {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
  low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
  renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
  postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; rendu sans post-traitement.',
  unknownGpu: 'GPU inconnu',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
    reflections: 'Reflets', particles: 'Particules', background: 'Animation du décor', detail: 'Détail de la scène',
  },
  tier: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé',
    static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
  },
  sum: {
    noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoFull: 'occlusion ambiante complète',
    bloom: 'halo', reflections: 'reflets', noAa: 'sans anticrénelage',
  },
});
STRINGS['fr-FR'] = FR;
STRINGS['fr-CA'] = merge(FR, { showFps: 'Afficher la fréquence d’images', cat: { antialias: 'Anticrénelage' } });

export const GFX_LOCALES = Object.keys(STRINGS);

export function pickLocale(lang) {
  const l = String(lang || 'en-US');
  if (STRINGS[l]) return l;
  const [base, region = ''] = l.split('-');
  if (base === 'en') return /^(GB|IE|AU|NZ|ZA|IN)$/i.test(region) ? 'en-GB' : 'en-US';
  if (base === 'es') return /^ES$/i.test(region) ? 'es-ES' : 'es-419';
  if (base === 'fr') return /^CA$/i.test(region) ? 'fr-CA' : 'fr-FR';
  if (base === 'de') return 'de-DE';
  if (base === 'pt') return 'pt-BR';
  if (base === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(locale) {
  return STRINGS[pickLocale(locale)];
}

const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

/** Localized cost summary: "GPU · effects · W×H px". */
export function summaryText(T, info) {
  const r = info.resolved;
  const parts = [
    info.gpu && info.gpu !== 'unknown GPU' ? info.gpu : T.unknownGpu,
    r.shadows === 'off' ? T.sum.noShadows : fmt(T.sum.shadows, { n: SHADOW_MAP[r.shadows] }),
    r.ao === 'off' ? null : r.ao === 'high' ? T.sum.aoFull : T.sum.ao,
    r.bloom === 'on' ? T.sum.bloom : null,
    r.reflections === 'on' ? T.sum.reflections : null,
    r.antialias === 'off' ? T.sum.noAa : r.antialias.toUpperCase(),
    info.pixels ? `${info.pixels[0]}×${info.pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * Build the panel into `root` (a <fieldset>). `get()` returns the saved
 * graphics object, `info()` the renderer's graphicsInfo() (or null for the 2D
 * path), `onChange(patch)` persists + applies ({preset} clears overrides).
 */
export function mountGraphicsPanel(root, { get, info, onChange, locale }) {
  const T = gfxStrings(locale);
  root.textContent = '';
  root.lang = pickLocale(locale);
  const legend = document.createElement('legend');
  legend.textContent = T.graphics;
  root.append(legend);

  const mkField = (label, control) => {
    const l = document.createElement('label');
    l.className = 'field';
    l.append(document.createTextNode(label), control);
    root.append(l);
    return l;
  };

  const quality = document.createElement('select');
  quality.id = 'set-tier';
  quality.dataset.gfx = 'preset';
  for (const p of ['auto', ...PRESETS]) {
    const o = document.createElement('option');
    o.value = p;
    quality.append(o);
  }
  quality.addEventListener('change', () => onChange({ preset: quality.value }));
  mkField(T.quality, quality);

  const scaleWrap = document.createElement('label');
  scaleWrap.className = 'slider gfx-scale';
  const scale = document.createElement('input');
  Object.assign(scale, { type: 'range', id: 'gfx-scale', min: '50', max: '200', step: '5' });
  scale.dataset.gfx = 'render_scale';
  const scaleOut = document.createElement('output');
  scaleOut.htmlFor = 'gfx-scale';
  scale.addEventListener('input', () => {
    scaleOut.textContent = `${scale.value}%`;
    onChange({ render_scale: Number(scale.value) / 100 });
  });
  scaleWrap.append(document.createTextNode(T.renderScale), scale, scaleOut);
  root.append(scaleWrap);

  const cats = {};
  const grid = document.createElement('div');
  grid.className = 'gfx-cats';
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = document.createElement('select');
    sel.id = `gfx-${cat}`;
    sel.dataset.gfx = cat;
    for (const v of ['preset', ...tiers]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'preset' ? '' : T.tier[v] || v;
      sel.append(o);
    }
    sel.addEventListener('change', () => onChange({ [cat]: sel.value }));
    const l = document.createElement('label');
    l.className = 'field';
    l.append(document.createTextNode(T.cat[cat]), sel);
    grid.append(l);
    cats[cat] = sel;
  }
  root.append(grid);

  const mkCheck = (id, key, label) => {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.id = id;
    c.dataset.gfx = key;
    c.addEventListener('change', () => onChange({ [key]: c.checked }));
    l.append(c, document.createTextNode(' ' + label));
    root.append(l);
    return c;
  };
  const adaptive = mkCheck('gfx-adaptive', 'adaptive', T.adaptive);
  const fps = mkCheck('gfx-fps', 'show_fps', T.showFps);

  const summary = document.createElement('p');
  summary.id = 'gfx-summary';
  summary.className = 'fine';
  summary.setAttribute('aria-live', 'polite');
  const note = document.createElement('p');
  note.id = 'gfx-note';
  note.className = 'fine warn';
  note.textContent = T.postUnavailable;
  note.hidden = true;
  root.append(summary, note);

  const sync = () => {
    const saved = get();
    const inf = info();
    const detected = inf?.detected || 'low';
    const r = inf?.resolved || resolve(saved, detected);
    for (const o of quality.options) o.textContent = o.value === 'auto' ? fmt(T.auto, { tier: T[detected] }) : T[o.value];
    quality.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    scale.value = String(pct);
    scaleOut.textContent = `${pct}%`;
    for (const [cat, sel] of Object.entries(cats)) {
      sel.options[0].textContent = fmt(T.fromPreset, { tier: T.tier[presetTier(r.preset, cat)] || '' });
      sel.value = CATEGORIES[cat].includes(saved[cat]) ? saved[cat] : 'preset';
    }
    adaptive.checked = saved.adaptive !== false;
    fps.checked = !!saved.show_fps;
    summary.textContent = inf ? summaryText(T, inf) : '';
    note.hidden = !inf?.postFailed;
    root.dataset.gfxPreset = r.preset;
  };
  const refresh = () => {
    const inf = info();
    summary.textContent = inf ? summaryText(T, inf) : '';
    note.hidden = !inf?.postFailed;
  };
  sync();
  return { sync, refresh };
}
