// Localization: the browser build's tables (js/strings.js through js/i18n.js,
// en-US text as the keys, the nine StarHermit locales; the account strings in
// js/platform-i18n.js) in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replace the game's own Language setting (sh-language.js) and the DOM
// re-labelling: every string is drawn through T() each frame, so a change
// shows on the next frame and never restarts a round or its clock.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { contentTitle as titleOf } from "../js/i18n.js";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An en-US source string (or symbolic key) in the player's language; `{name}` placeholders from vars. A text with no entry is itself. */
export function T(key: string, vars?: Vars | null): string {
  const k = String(key);
  if (strings.has(k)) return strings.t(k, vars ?? undefined);
  return vars ? k.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : k;
}
/** Marks an en-US key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The engine's account strings. */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
/** A canvas title (content meta.title) in the player's language. */
export function contentTitle(title: string): string { return titleOf(title, T) as string; }
/** Locale-aware digit grouping (i18n.js num), without Intl. */
export function num(n: number): string {
  const locale = strings.locale;
  const s = String(Math.round(Number(n) || 0));
  const sep = locale.startsWith("en") ? "," : locale.startsWith("fr") ? " " : locale === "es-419" ? "," : ".";
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
/** m:ss (ui.js fmtTime). */
export function fmtTime(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
