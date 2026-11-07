// Pixel Atelier: canvas titles in the current language, through the T() given (native/i18n.ts over the engine's strings; assets/strings.json holds the tables).
'use strict';

/** Canvas titles (content meta.title) in the current language. */
export function contentTitle(title, t) {
  const s = String(title || '');
  let m;
  if ((m = /^Daily — (\S+) \((\w+)\)$/.exec(s))) return t('Daily — {date} ({twist})', { date: m[1], twist: t('twist.' + m[2]) });
  if ((m = /^Daily — (\S+)$/.exec(s))) return t('Daily — {date}', { date: m[1] });
  if ((m = /^Practice — (.+)$/.exec(s))) return t('Practice — {preset}', { preset: t(m[1]) });
  if ((m = /^Score Chase — Week (.+)$/.exec(s))) return t('Score Chase — Week {week}', { week: m[1] });
  if ((m = /^(.+) (I|II|III)$/.exec(s))) return t(m[1]) + ' ' + m[2];
  return t(s);
}
