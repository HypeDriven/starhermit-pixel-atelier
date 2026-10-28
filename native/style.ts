// The look of the HUD, rails, tray, overlays and screens: the browser build's
// styles.css, rewritten class-based in tools/ui-style.css and converted once
// with `starhermit css` into assets/ui-style.json (`npm run css`), registered
// at start with the theme the runtime's own widgets (scroll bars, focus
// rings, selects, text fields) take. The runtime's high-contrast option is
// the old body.high-contrast token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#05070f", panel: "#0d1426eb", "panel-solid": "#0d1426", edge: "#1c2b4d", text: "#e8eefc", dim: "#93a4c8",
  "accent-a": "#22d3ee", "accent-b": "#f472b6", danger: "#ff5d5d", ok: "#3fd68f", gold: "#ffd166", field: "#0a1225", card: "#101a31",
};
/** body.high-contrast. */
const CONTRAST: Tokens = { panel: "#020610f7", text: "#ffffff", dim: "#c9d6f2", edge: "#4a6db3" };

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.1, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: BASE.text!, muted: BASE.dim!, panel: BASE["panel-solid"]!, control: "#131f3a", hovered: "#1a2a4e",
    pressed: "#22335c", field: BASE.field!, accent: BASE["accent-a"]!, focus: BASE["accent-b"]!, outline: BASE.edge!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$accent-b", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$edge", radius: 4 } } },
    tooltip: { background: "$panel-solid", text: { color: "$text" }, radius: 6, padding: 6 },
    // .overlay: rgba(3, 5, 12, 0.7) behind the pause and confirm cards.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#03050cb3" } } },
  });
  key = "";
  applyTokens(false);
}

let key = "";
/** The base or high-contrast tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({ text: current.text!, muted: current.dim!, outline: current.edge! });
}
/** A token's current color (for draw calls, which take real colors). */
export function token(name: string): string { return current[name] ?? "#000000"; }
