// Localization: the browser build's tables (js/strings.js through js/i18n.js,
// en-US text as the keys, the nine StarHermit locales; the account strings in
// js/platform-i18n.js) in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replace the game's own Language setting (sh-language.js) and the DOM
// re-labelling: every string is drawn through T() each frame, so a change
// shows on the next frame and never restarts a round or its clock.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { contentTitle as titleOf, setLocale, t } from "../js/i18n.js";
import { pickPlatformLocale, platformStrings } from "../js/platform-i18n.js";

let locale = "";
function apply(tag: string): void {
  const next = pickPlatformLocale(String(tag || "en-US")) as string;
  if (next === locale) return;
  locale = next;
  setLocale(locale);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
/** An en-US source string (or symbolic key) in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return t(key, vars ?? undefined) as string; }
/** Marks an en-US key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The account strings (signIn, invite, inviteCopied, inviteFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string {
  let s = (platformStrings(locale) as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
/** A canvas title (content meta.title) in the player's language. */
export function contentTitle(title: string): string { return titleOf(title) as string; }
/** Locale-aware digit grouping (i18n.js num), without Intl. */
export function num(n: number): string {
  const s = String(Math.round(Number(n) || 0));
  const sep = locale.startsWith("en") ? "," : locale.startsWith("fr") ? " " : locale === "es-419" ? "," : ".";
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
/** m:ss (ui.js fmtTime). */
export function fmtTime(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
