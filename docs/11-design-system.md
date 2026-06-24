# 11 — Design System ("Delfínek")

> The visual layer that sits on top of the headless core. The default theme is **Delfínek** — an
> earthy, calm hunter‑green skin extracted verbatim from the three product mockups. It is the
> **default**, not the only, theme: every color is a token, so a tenant can re‑skin the whole product
> (white‑label) by overriding a handful of CSS variables (see [03](03-data-model.md) `tenants.branding`).
>
> **Where it lives.** The headless `@reservation-core/*` packages ship **no theme**. The theme,
> tokens, and Mantine primitives ship in `@reservation-core/ui-mantine` (see [02](02-reservation-core.md) §3).
> An app renders inside `<MantineProvider theme={delfinekTheme}>` with a `:root` token sheet; a tenant's
> branding patches the sheet at runtime. The component code never names a color literal — exactly the
> "delegate all component colors to CSS variables" approach proven in `restaurio/admin-console/theme.ts`.

The three surfaces this system dresses:

| Surface | Mockup | Canvas | Audience | Stance |
|---|---|---|---|---|
| **Admin console** | `Termínář Admin` | sidebar 248 + content `max-width:1240px` | staff (coach→owner) | desktop‑first |
| **Family portal** | `Termínář Rodič – Náhrady` | header‑only, content `max-width:1160px` | family (guardian) | desktop‑first, responsive |
| **Public enrollment** | `Termínář Zápis (QR formulář)` | phone frame, canvas `404px` | anonymous (QR) | mobile‑first |

---

## 1. Principles

1. **Earthy & calm.** A warm cream paper (`#f4f2ea`) under a hunter→fern green family. No pure white
   backgrounds, no saturated "SaaS blue." Greens carry brand *and* the primary "free / success" semantic,
   so the palette stays small.
2. **High legibility first.** Display type (Bricolage Grotesque) for hierarchy; body type (Hanken Grotesk)
   tuned for long rosters and forms; generous line‑height (1.4–1.5) on prose.
3. **Numbers are data.** Every time, date, count, capacity, age, phone, and money string is set in
   `Spline Sans Mono` with `font-variant-numeric: tabular-nums` (the `.tnum` utility) so columns align and
   live values don't reflow.
4. **Quiet surfaces, loud state.** Cards are flat cream/white with a 1px warm border and a barely‑there
   shadow; *color* is reserved for status (free, full, paid, excused, …). The eye finds state, not chrome.
5. **White‑label‑ready by construction.** Nothing in a component hard‑codes a hex. Brand color, logo, and
   fonts are tokens a tenant overrides; the rest of the scale is locked so re‑skins stay coherent (§4).
6. **One token set, two schemes.** Light and dark are the *same* components reading the *same* variable
   names — only the `:root` / `[data-mantine-color-scheme]` values differ (§3).

---

## 2. Design tokens

The single source of truth. Emitted two ways: a **CSS custom‑property sheet** (consumed by raw CSS, the
phone form, and Mantine `styles` that read `var(--…)`), and a **Mantine `createTheme()`** mapping that wires
the same values into Mantine's `primaryColor`, fonts, radii, and per‑component `defaultProps`.

### 2.1 Color scale

Organized from the raw mockup hexes into a coherent ramp. Names are stable; values are the Delfínek defaults.

**Brand / fern ramp** (sidebar & brand → action). Indices follow Mantine's 0→9 (light→dark); the primary
action `fern` is index **6**.

| Token | Hex | Mockup role |
|---|---|---|
| `--color-fern-0` | `#f2f7ec` | lightest tint (selected card bg in form) |
| `--color-fern-1` | `#eef3e9` | info panel / step bg |
| `--color-fern-2` | `#e4ecda` | free‑slot fill |
| `--color-fern-3` | `#dde7d4` | **light sage** — avatars, badges, "active" pill, selection |
| `--color-fern-4` | `#a3b18a` | **sage** — logo chip, portal avatar |
| `--color-fern-5` | `#588157` | (alias of action; used for sliders/accent) |
| `--color-fern-6` | `#588157` | **FERN — primary action / CTA** (`accent-color`, pills, focus) |
| `--color-fern-7` | `#487049` | hover (darker fern) |
| `--color-fern-8` | `#3a5a40` | deep text‑green (links, emphasized labels) |
| `--color-fern-9` | `#25382e` | darkest (icon‑on‑sage, contrast text) |
| `--color-brand` | `#344e41` | **hunter** — sidebar, brand mark, toast bg (≈ fern‑8.5) |

**Surfaces & paper**

| Token | Hex | Role |
|---|---|---|
| `--color-bg` | `#f4f2ea` | app background (primary cream) |
| `--color-surface` | `#ffffff` | cards, table body, inputs |
| `--color-surface-raised` | `#faf9f5` | off‑white — table header, segmented track, inset tiles, modal footer |
| `--color-bg-sunken` | `#e9e6dc` | deep cream — public‑form page bg |
| `--color-bg-sunken-2` | `#f1efe7` | "occupied" slot fill / cancel‑hover |
| `--color-phone-frame` | `#0d1611` | device bezel & notch (public mockup) |

**Ink / text**

| Token | Hex | Role | Pairs on `--color-bg`/`surface` |
|---|---|---|---|
| `--color-ink` | `#1a2a21` | primary text | AA✓ (≈ 13:1) |
| `--color-ink-strong` | `#2f4536` | dark heading variant | AA✓ |
| `--color-ink-2` | `#3a4a40` | form label text | AA✓ |
| `--color-ink-3` | `#45443a` | body emphasis / table cell | AA✓ |
| `--color-text-muted` | `#5c5b4f` | muted body, secondary | AA✓ (≈ 6.6:1) |
| `--color-text-secondary` | `#6f6e60` | secondary copy | AA✓ (≈ 5:1) |
| `--color-text-faint` | `#7e7c6e` | captions, eyebrows, table headers | AA✓ for ≥16px / large; **AA‑large only** at body sizes (≈ 4.0:1) |
| `--color-text-disabled` | `#a3a294` | faint / hour‑axis labels | fails AA — decorative/disabled only |
| `--color-placeholder` | `#a8a698` | input placeholder | fails AA — placeholder only |

**Borders & lines**

| Token | Hex | Role |
|---|---|---|
| `--color-border` | `#e2e0d6` | default hairline (cards, header, table rows) |
| `--color-border-soft` | `#ebe9df` | softer divider (phone chrome) |
| `--color-border-soft-2` | `#eceae0` | inset tile border, progress track, grid lines |
| `--color-input-border` | `#cbc9bc` | input / select / textarea border |
| `--color-border-strong` | `#d9d7cb` | dashed "off‑age" slot, secondary button border (`#d3d1c4` on phone) |
| `--color-free-border` | `#b6c79a` | free‑slot border |
| `--color-info-border` | `#d9e3cd` | info‑tint panel border (`#d4e0c8` variant) |

**Status** (semantic — each maps a `bg` + `fg`, some a `border`)

| Semantic | `bg` | `fg` | `border` | Used for |
|---|---|---|---|---|
| `success` / `present` / `free` | `#dde7d4` (`#e4ecda` slot) | `#3a5a40` | `#a3b18a` / `#b6c79a` | "Aktivní", "Přítomen", free slot; free‑pill `#588157`/`#fff` |
| `warning` / `excused` / `ended` | `#f6ead0` | `#8a611a` | `#d8b572` | "Omluven", "Proběhlý"; near‑full occupancy text `#b9842b` |
| `danger` / `absent` / `cancelled` | `#f4e0db` (`#fbeeec` hover) | `#803129` | `#e2c4be` / `#d79a90` | "Nepřítomen", "Zrušeno", reject; over‑full text `#a03c30`/`#ab453a` |
| `info` | `#eef3e9` | `#3f5a44` | `#d9e3cd` | form/registration info banners |
| `neutral` / `draft` / `none` | `#efeee7` (`#ece9df`) | `#5c5b4f` / `#7e7c6e` | — | "Koncept", "Neoznačeno", full‑slot pill |
| `teal` (accent course) | `#d9e7e3` | `#2f544e` | — | "Dokončeno", calendar "Zdokonalovací" |
| `toast` | `#344e41` | `#f4f2ea` | — | toast surface; toast icon `#a3b18a` |

> Course‑calendar event tones (`TONE` in the mockup): `green #dde7d4/#344e41` · `sage #e3e8d6/#3a5a40` ·
> `teal #d9e7e3/#2f544e` · `ochre #f6ead0/#8a611a` · `clay #f4e0db/#803129`. These are decorative
> category hues drawn from the status palette.

### 2.2 Typography

Three families, loaded from Google Fonts (Bricolage Grotesque `12..96` opsz, Hanken Grotesk, Spline Sans Mono).

| Role | Family | Size / weight | Notes |
|---|---|---|---|
| Page title (`h1`) | Bricolage | 28px / 600 (portal 30px) | `letter-spacing:-0.01em`, `line-height:1.12–1.15` |
| Section `h2` | Bricolage | 22–24px / 600 | tight tracking |
| Sub‑head `h3` | Bricolage | 18–22px / 600 | card/modal titles |
| Modal title | Bricolage | 20px / 600 | |
| Stat tile value | Bricolage | 24px / 600 (profile 22; balance 30) | `.tnum`, color `--color-brand` / `--color-fern-8` |
| Body | Hanken | 14–15px / 400–500 | default UI text |
| Body strong | Hanken | 14–15px / 600 | names, emphasis |
| Label (form) | Hanken | 13px / 600 | `--color-ink-2` |
| Caption / meta | Hanken | 11–13px / 400–500 | `--color-text-faint` |
| **Eyebrow** | Hanken | 11px / 600 | `uppercase`, `letter-spacing:.04–.07em`, `--color-text-faint` |
| Table header | Hanken | 13px / 500 | `--color-text-muted` |
| **Mono / numeric** | Spline Sans Mono | 11–16px / 400–600 | times, dates, counts, money, phone; always `.tnum` |
| Button | Hanken | 13–15.5px / 600 | per control size |

```css
--font-display: 'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-sans:    'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono:    'Spline Sans Mono', ui-monospace, 'SF Mono', monospace;
```

### 2.3 Radii, spacing, elevation, motion

| Token | Value | Applies to |
|---|---|---|
| `--radius-chip` | `6px` (tags `6`, slot/session `9–12`) | tags, pills-square |
| `--radius-control` | `8px` | segmented item, letter filter, "this week" |
| `--radius-sm` | `9px` | small buttons, attendance toggles |
| `--radius-md` | `10px` | inputs, buttons, segmented track, icon buttons |
| `--radius-input` | `11px` | phone inputs / cards (mobile) |
| `--radius-lg` | `12px` | stat tiles, empty‑state icon chip |
| `--radius-card` | `14px` | cards, panels, tables |
| `--radius-modal` | `16px` | modals, drawers, summary card |
| `--radius-pill` | `999px` | avatars, status pills, toggles, balance chip |
| `--radius-logo` | `10–11px` | sidebar / header logo chip |
| `--radius-phone` | `36px` (bezel `46px`) | device frame |

Spacing scale (px), used for gap/padding throughout: `2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 22 · 24 · 32`.

```css
--shadow-card:  0 1px 3px rgba(37,56,46,.08), 0 1px 2px rgba(37,56,46,.04);
--shadow-modal: 0 12px 28px rgba(37,56,46,.24), 0 4px 8px rgba(37,56,46,.10);
--shadow-phone: 0 18px 44px rgba(37,56,46,.22), 0 4px 12px rgba(37,56,46,.12);
--ring-focus:   0 0 0 3px rgba(88,129,87,.18);   /* forms use .16 */
--motion-fast:  120ms;   /* control state changes */
--motion-base:  140ms;   /* hover, toggles, transforms */
```

Hover convention: **brightness** for filled chips (`filter:brightness(.97)`), **bg shift** for outline
controls (`#fff → #faf9f5` / `#eef2ea`), darker fern for primary (`#588157 → #487049`). Focus ring is
always fern border + the `--ring-focus` halo; text selection is `--color-fern-3` (`#dde7d4`).

### 2.4 The `:root` sheet (excerpt)

```css
:root {
  /* paper & surface */
  --color-bg: #f4f2ea;            --color-surface: #fff;
  --color-surface-raised: #faf9f5; --color-bg-sunken: #e9e6dc;
  /* brand & action */
  --color-brand: #344e41;        --color-fern: #588157;
  --color-fern-hover: #487049;   --color-fern-deep: #3a5a40;
  --color-sage: #a3b18a;         --color-sage-light: #dde7d4;
  /* ink */
  --color-ink: #1a2a21;          --color-text-muted: #5c5b4f;
  --color-text-faint: #7e7c6e;   --color-placeholder: #a8a698;
  /* lines */
  --color-border: #e2e0d6;       --color-input-border: #cbc9bc;
  /* status (bg/fg pairs) */
  --color-success-bg: #dde7d4;   --color-success-fg: #3a5a40;
  --color-warning-bg: #f6ead0;   --color-warning-fg: #8a611a;
  --color-danger-bg:  #f4e0db;   --color-danger-fg:  #803129;
  --color-info-bg:    #eef3e9;   --color-info-fg:    #3f5a44;
  /* radii / shadow / font / motion — see §2.3 */
  --radius-md: 10px; --radius-card: 14px; --radius-modal: 16px; --radius-pill: 999px;
  --shadow-card: 0 1px 3px rgba(37,56,46,.08), 0 1px 2px rgba(37,56,46,.04);
  --ring-focus: 0 0 0 3px rgba(88,129,87,.18);
  --font-display: 'Bricolage Grotesque', system-ui, sans-serif;
  --font-sans: 'Hanken Grotesk', system-ui, sans-serif;
  --font-mono: 'Spline Sans Mono', ui-monospace, monospace;
}
::selection { background: var(--color-sage-light); }
.tnum { font-variant-numeric: tabular-nums; }
```

### 2.5 The Mantine `createTheme()` mapping

`primaryColor: 'fern'` registers the 10‑shade ramp from §2.1; `defaultProps` delegate every component color
to the CSS vars — the **same pattern** as `restaurio/admin-console/theme.ts` (so a runtime var swap re‑skins
Mantine components without touching JS).

```ts
// @reservation-core/ui-mantine/theme.ts
import { createTheme, rem } from '@mantine/core';

export const delfinekTheme = createTheme({
  primaryColor: 'fern',
  primaryShade: { light: 6, dark: 5 },
  colors: {
    // 0 → 9  (light → dark), index 6 = action fern
    fern: ['#f2f7ec','#eef3e9','#e4ecda','#dde7d4','#a3b18a',
           '#6f9e5e','#588157','#487049','#3a5a40','#25382e'],
    hunter: ['#e7ece8','#cdd8cf','#a9bcb0','#7e9a87','#5d7d68',
             '#456451','#344e41','#2b4135','#22332a','#19261f'],
  },
  white: '#ffffff',
  black: '#1a2a21',
  fontFamily: 'var(--font-sans)',
  fontFamilyMonospace: 'var(--font-mono)',
  headings: { fontFamily: 'var(--font-display)', fontWeight: '600' },
  defaultRadius: 'md',                       // 10px
  radius: { sm: rem(8), md: rem(10), lg: rem(14) },
  fontSizes: { xs: rem(11), sm: rem(13), md: rem(14), lg: rem(15), xl: rem(18) },
  shadows: {
    sm: '0 1px 3px rgba(37,56,46,.08), 0 1px 2px rgba(37,56,46,.04)',
    xl: '0 12px 28px rgba(37,56,46,.24), 0 4px 8px rgba(37,56,46,.10)',
  },
  focusRing: 'auto',
  components: {
    TextInput:  { defaultProps: { styles: inputStyles } },
    Textarea:   { defaultProps: { styles: inputStyles } },
    Select:     { defaultProps: { styles: { ...inputStyles, dropdown: dropdownStyle } } },
    NumberInput:{ defaultProps: { styles: inputStyles } },
    Button: { defaultProps: { radius: 'md' }, styles: {
      root: { fontWeight: 600, fontFamily: 'var(--font-sans)' } } },
    Card:   { defaultProps: { radius: 'lg', withBorder: true }, styles: {
      root: { backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border)',
              boxShadow: 'var(--shadow-card)' } } },
    Paper:  { styles: { root: { backgroundColor: 'var(--color-surface)',
                                borderColor: 'var(--color-border)' } } },
    Modal:  { defaultProps: { radius: 'modal', overlayProps: { color: '#25382e', backgroundOpacity: .45 } },
              styles: { content: { backgroundColor: 'var(--color-surface)',
                                   boxShadow: 'var(--shadow-modal)' },
                        header:  { backgroundColor: 'var(--color-surface)' } } },
    Table:  { defaultProps: { highlightOnHover: true },
              styles: { thead: { backgroundColor: 'var(--color-surface-raised)' },
                        th: { color: 'var(--color-text-muted)', fontWeight: 500, fontSize: rem(13) } } },
    Badge:  { styles: { root: { textTransform: 'none', fontWeight: 600 } } },
    Tabs:   { styles: { tab: { fontWeight: 500 } } },
    Switch: { defaultProps: { color: 'fern' } },
    Slider: { defaultProps: { color: 'fern' } },
    Tooltip:{ defaultProps: { color: 'hunter' } },
  },
});

const inputStyles = {
  input: { backgroundColor: 'var(--color-surface)',
           borderColor: 'var(--color-input-border)',
           color: 'var(--color-ink)',
           // focus handled by focusRing + global :focus rule using --ring-focus
         },
  label: { color: 'var(--color-ink-2)', fontWeight: 600, fontSize: rem(13) },
};
const dropdownStyle = { backgroundColor: 'var(--color-surface)',
                        borderColor: 'var(--color-border)' };
```

> The two layers compose: Mantine owns layout/state of its components, the CSS vars own the *colors*.
> A tenant override (§4) repaints both at once because both read the same `--color-*` names.

---

## 3. Dark mode

The hunter‑green family already reads as a "night" palette, so dark mode keeps the *same hue* and inverts
lightness. `MantineProvider` runs with `defaultColorScheme="auto"`; the dark token set is published under
`[data-mantine-color-scheme="dark"]` (and `@media (prefers-color-scheme: dark)` for the raw‑CSS phone form).
**No component changes** — only variable values flip, because every primitive already reads `var(--color-*)`.

| Token | Light | Dark |
|---|---|---|
| `--color-bg` | `#f4f2ea` | `#16211b` |
| `--color-surface` | `#fff` | `#1e2b24` |
| `--color-surface-raised` | `#faf9f5` | `#25342b` |
| `--color-brand` (sidebar) | `#344e41` | `#1a2620` |
| `--color-ink` | `#1a2a21` | `#eaf1ea` |
| `--color-text-muted` | `#5c5b4f` | `#a8b3a6` |
| `--color-text-faint` | `#7e7c6e` | `#84907f` |
| `--color-border` | `#e2e0d6` | `#314238` |
| `--color-input-border` | `#cbc9bc` | `#3a4d41` |
| `--color-fern` (action) | `#588157` | `#6f9e5e` (shade 5, lifted for contrast on dark) |
| `--color-success-bg` / `fg` | `#dde7d4` / `#3a5a40` | `#2c4634` / `#a8c79b` |
| `--color-warning-bg` / `fg` | `#f6ead0` / `#8a611a` | `#3d3220` / `#e2b873` |
| `--color-danger-bg` / `fg` | `#f4e0db` / `#803129` | `#3a2622` / `#e3a59b` |
| `--shadow-card` | `…rgba(37,56,46,.08)` | `0 1px 3px rgba(0,0,0,.4)` |
| `--ring-focus` | `…rgba(88,129,87,.18)` | `0 0 0 3px rgba(111,158,94,.35)` |

Rule: in dark, status **fills darken** and status **text lightens** (keep ≥ 4.5:1); the primary action steps
from fern‑6 to fern‑5 so the CTA stays bright against `--color-surface`. The dark‑mode toggle in the admin
header (`ti ti-moon`) flips Mantine's scheme and persists it.

---

## 4. White‑labeling

The product is multi‑tenant; Delfínek is just tenant‑zero's skin. A tenant's `tenants.branding`
(see [03](03-data-model.md)) carries the override, resolved server‑side and injected as a small `<style>` of
CSS‑var overrides on the document root (so it applies before first paint, no flash).

```ts
// tenants.branding (subset)
interface TenantBranding {
  brandColor?: string;          // seeds fern ramp → --color-fern / brand / hover
  accentColor?: string;         // optional secondary
  logoUrl?: string;             // replaces the ti-pool chip
  logoMonoUrl?: string;         // sidebar/dark variant
  fontDisplay?: string;         // overrides --font-display (must be self-hosted/whitelisted)
  fontSans?: string;            // overrides --font-sans
  radiusScale?: 'soft' | 'default' | 'sharp';   // nudges --radius-* set
}
```

At runtime the resolver derives a 10‑shade ramp from `brandColor` (same index map as §2.1) and emits:

```css
:root[data-tenant="kapicka"] {
  --color-fern: #2f6f8f; --color-fern-hover: #275c77; --color-fern-deep: #234f63;
  --color-brand: #1f4a5e; --color-sage-light: #d4e6ee;
  --ring-focus: 0 0 0 3px rgba(47,111,143,.18);
  --font-display: 'Sora', var(--font-display);
}
```

**Themeable vs locked:**

| Themeable per tenant | Locked (ships with `ui-mantine`) |
|---|---|
| Brand/action color (→ fern ramp), accent | Status semantics (success=green, danger=clay, warning=amber) — meaning must stay constant |
| Logo (light + mono), brand wordmark | Layout metrics (sidebar 248, header 64, content 1240/1160, phone 404) |
| Display & body font (whitelisted/self‑hosted) | Spacing scale, shadow recipe, focus‑ring shape |
| Radius scale (soft/default/sharp nudge) | Mono family for numerics (tabular alignment is functional) |
| Light/dark default & accent‑on‑dark lift | Component structure / `defaultProps` contract |

This keeps re‑skins coherent (a tenant can't break contrast or accidentally turn "danger" green) while still
feeling owned. The **headless core ships no theme at all**; only `@reservation-core/ui-mantine` carries
Delfínek and the override machinery (see [02](02-reservation-core.md) §3).

---

## 5. Component inventory

Every entry below is lifted from the mockups with its exact tokens, so the Mantine build can match pixel‑for‑pixel.

### 5.1 Buttons

| Variant | Spec |
|---|---|
| **Primary (fern)** | `bg #588157`, `color #fff`, `radius 10`, `h 38` (modal/CTA `42–50`), `weight 600`; hover `#487049`. Icon‑left gap 7–8. |
| **Secondary (outline)** | `bg #fff`, `border 1px #cbc9bc`, `color #3a5a40`, `radius 10`; hover bg `#faf9f5` (or `#eef2ea`). Phone variant border `#d3d1c4`, radius 13. |
| **Neutral outline** | `border #e2e0d6`, `color #5c5b4f` — "Vrátit", close, nav arrows; hover `#faf9f5`. |
| **Danger‑ghost** | square `34×34`, `border #e2c4be`, `color #a03c30`; hover bg `#fbeeec` — reject submission. |
| **Icon button** | square `36–38`, `radius 10`, `border #e2e0d6`, `color #5c5b4f`, `bg #fff`; hover `#faf9f5` — bell, moon, month nav. |
| **Disabled CTA** | `bg #cfd6c7`/`#bcc6ad`, `color #fff`, `cursor not-allowed` — incomplete wizard / no balance. |

### 5.2 Inputs, select, textarea

`height 40` (admin filters) / `44` (admin modal) / `48` (phone); `radius 10` (admin) / `11` (phone);
`border 1px #cbc9bc` (phone `1.5px`); `bg #fff`; `font 15`; `color #1a2a21`; placeholder `#a8a698`.
**Focus:** `border-color #588157` + `box-shadow var(--ring-focus)` (forms `.16`). Search input has a leading
`ti ti-search` at `left 12`, `#7e7c6e`. Native `<select>` is `appearance:none` with an absolutely‑positioned
`ti ti-chevron-down` (`#7e7c6e`, `pointer-events:none`). Textarea `min-height 72–84`, `resize:vertical`,
`line-height 1.5`.

### 5.3 Cards & panels

`bg #fff`, `border 1px #e2e0d6`, `radius 14`, `--shadow-card`. Inset tiles inside a card use
`bg #faf9f5`, `border #eceae0`, `radius 12`. Card header rows: `padding 16px 20px`, `border-bottom #e2e0d6`,
title in Bricolage 18–22.

### 5.4 Tables

Container is a card with `overflow:hidden`. Header row `bg #faf9f5`, `border-bottom #e2e0d6`, cells
`th { font-size 13; font-weight 500; color #5c5b4f; text-align:left }`. Body row `border-bottom #e2e0d6`,
hover `bg #faf9f5`, `cursor:pointer` when the row opens a detail. Name cells pair a `34×34` round
`#dde7d4`/`#3a5a40` avatar with a `#3a5a40` 600 name. Numeric cells get `.tnum`. **Sortable header:** clickable
`th` flips its arrow icon — inactive `ti ti-arrows-up-down` (`#b7b5a8`), active `ti ti-arrow-up/-down`
(`#588157`) and the label recolors to `#3a5a40`.

### 5.5 Status badges & pills

Pill = `display:inline-flex; padding:4px 11px; radius 999; font 12/600`. Square tag = `padding:2px 8px;
radius 6; font 11/500/600`. The **status → color** map (single source for badges, table chips, attendance):

| Status | bg / fg |
|---|---|
| Aktivní · Přítomen | `#dde7d4 / #3a5a40` |
| Koncept · Neoznačeno | `#efeee7 / #5c5b4f` (faint `#7e7c6e`) |
| Proběhlý · Omluven | `#f6ead0 / #8a611a` |
| Zrušeno · Nepřítomen | `#f4e0db / #803129` |
| Dokončeno | `#d9e7e3 / #2f544e` |
| Tag (course meta) | `#eef2ea / #487049` |

Free‑slot pill is the inverse — solid `#588157` on `#fff`; "Rezervováno vámi" pill is
`rgba(255,255,255,.22)` on the green block.

### 5.6 Tabs / segmented control

Track: `bg #faf9f5`, `border 1px #e2e0d6`, `radius 10`, `padding 3`, `gap 2`. Item: `padding 7px 14px`,
`radius 8`, `font 14`. **Active** item lifts to `bg #fff`, `color #344e41`, `weight 600`,
`box-shadow 0 1px 2px rgba(37,56,46,.10)`; inactive `color #5c5b4f`, transparent. The same control serves view
toggles (Seznam/Kalendář), bucket filters, age/payment filters, and the attendance lessons/overview switch.
**Letter filter** (A–Z): `32×32`, `radius 8`, `font 13/600`; active solid `#588157`/`#fff`, inactive
`#fff`/`#5c5b4f` border `#e2e0d6`.

### 5.7 Sidebar nav item

Container `width 248`, `bg #344e41`, `color #f4f2ea`, `padding 20 12`, sticky full‑height. Logo chip `32×32`,
`radius 10`, `bg #a3b18a`, icon `#25382e`. Item: `padding 9px 12px`, `radius 10`, `gap 11`, `font 15`, icon 18.
**Default** `color rgba(244,242,234,.78)`, weight 500, transparent. **Active** `color #faf9f5`, weight 600,
`bg rgba(163,177,138,.22)`. Footer user block: `34×34` round sage avatar, name `#faf9f5`, sub at
`rgba(244,242,234,.6)`, top `border rgba(255,255,255,.12)`.

### 5.8 Stat tiles

`bg #fff`, `border #e2e0d6`, `radius 12`, `padding 14px 16px`, `--shadow-card`. Eyebrow row: icon (16,
`#7e7c6e`) + uppercase 11/600 label. Value: Bricolage 24/600 `.tnum`, color `#344e41`. (Submission stats add a
tone color on the icon; profile tiles use the `#faf9f5` inset variant.)

### 5.9 Modals & drawers

Overlay `rgba(37,56,46,.45)`, content `bg #fff`, `radius 16`, `--shadow-modal`, widths `440 / 540 / 560`.
Header: `padding 20–22px 24px`, `border-bottom #e2e0d6`, optional `42–52px` rounded icon/avatar chip, title
Bricolage 20–22, eyebrow above. Body `padding 22px 24px`, `max-height 64vh`, `overflow:auto`. Footer
(when present) `bg #faf9f5`, `border-top #e2e0d6`, right‑aligned buttons. Close = neutral icon button. The
portal reservation modal stacks info rows (`ti-calendar / map-pin / users / friends`, icons `#588157`) and a
fern or danger balance banner.

### 5.10 Toasts

Fixed `bottom 24 / right 24`, `bg #344e41`, `color #f4f2ea`, `radius 12`, `padding 12px 18px`,
`--shadow-modal`, `font 14/500`, leading icon `#a3b18a` (e.g. `ti-circle-check`, `ti-calendar-check`,
`ti-alert-circle`). Auto‑dismiss ~2.6–2.8s.

### 5.11 Calendar grids

**Month (admin):** card with header (`červen 2026` Bricolage 22 + prev/next icon buttons). 7‑col grid;
weekday header `bg #faf9f5`, eyebrow 11/600 uppercase `#7e7c6e`; cells bordered `#e2e0d6`; events are tiny
chips `time(.tnum, opacity .75) + title` tinted by `TONE`.
**Week with time axis (portal):** `grid-template-columns: 60px repeat(6,1fr)`. Left axis `bg #faf9f5` with
absolutely‑positioned hour labels (Spline Mono 11, `#a3a294`). Day columns draw hour gridlines via
`repeating-linear-gradient(... #eceae0 ...)`; **today** column tints `#f3f6ef` (header `#eef2ea`). Session
blocks are absolutely positioned by minute → px (`HOUR_H = 84`).

### 5.12 Slot / booking blocks (occupancy)

Four states (portal week + public picker share the language):

| State | bg / border / name / pill |
|---|---|
| **free** | `#e4ecda` / `#b6c79a` / `#2c4634` · pill `#588157`/`#fff` "N míst" |
| **full** | `#f1efe7` / `#e2e0d6` / `#6f6e61` · pill `#ece9df`/`#8a8676` "Obsazeno" |
| **off‑age** | `#f6f5ef` / dashed `#d9d7cb` / `#9a998d` · `opacity .72`, no pill |
| **booked** | solid `#588157` / `#487049` / `#fff` · pill `rgba(255,255,255,.22)` "Rezervováno" |

Public picker occupancy text colors: free `#5e7d59`, near‑full (≤2) `#b9842b`, full `#ab453a`; selected slot
`border 1.5px #588157`, `bg #f2f7ec`, `box-shadow 0 0 0 3px rgba(88,129,87,.16)`.

### 5.13 Attendance roster row

Row holds: round `38×38` `#dde7d4`/`#3a5a40` avatar + name/meta button (hover `opacity .65`), a state badge,
then a 3‑button group. Each toggle is `38×38`, `radius 9`, `transition all 120ms`:

| Toggle | active bg / fg / border | icon |
|---|---|---|
| Přítomen | `#dde7d4 / #3a5a40 / #a3b18a` | `ti ti-check` |
| Omluven | `#f6ead0 / #8a611a / #d8b572` | `ti ti-calendar-x` |
| Nepřítomen | `#f4e0db / #803129 / #d79a90` | `ti ti-x` |
| *(inactive, any)* | `#fff / #a8a698 / #e2e0d6` | — |

Beside the roster, a sticky summary card with a "Označeno" progress bar, color‑dot legend rows, a fern
**Uložit docházku** button (`ti-device-floppy`), and an amber info note about auto‑issued omluvenky.

### 5.14 Progress bar, range slider, toggle

**Progress:** track `#eceae0` (phone `#e7eade`), `height 6–8`, `radius 999`; fill `#588157` with
`transition width .2s`. **Range slider:** native `input[type=range]` with `accent-color:#588157`; the portal
age slider pairs it with min/max ticks in Spline Mono `#a3a294` and preset chips. **Toggle/switch:** `44×26`
pill track `#cbc9bc → #588157`, white `20×20` knob with `box-shadow 0 1px 2px rgba(37,56,46,.3)`,
`transform/​background transition 140ms`.

### 5.15 Public mobile wizard chrome

Phone bezel `#0d1611`, `padding 11`, `radius 46`, `--shadow-phone`; screen `radius 36`, `bg #f4f2ea`,
`812px` tall. Faux status bar (`9:41`, notch, signal icons). App header `bg #fff` with logo chip `38×38`
`#344e41`/`#dde7d4`. **Progress header**: eyebrow "Krok N ze 4" (`#3a5a40`) + step label + the 6px fern
progress bar, `border-bottom #ebe9df`. **Footer nav**: `bg #fff`, `border-top #ebe9df`, back = `50px` outline
square (`ti-arrow-left`), next = full fern `50px` CTA (disabled `#cfd6c7`). Course/slot pickers, the inline
"recommended by age" info card, the GDPR custom checkbox (`23×23`, `radius 7`, fern when checked), and the
success screen (`78px` round sage check, summary key/value card) all reuse the tokens above.

### 5.16 Empty states

Centered: rounded `48–56px` icon chip `bg #eef2ea`, `color #588157` (`radius 12–14`), a 16–22 title, and a
`#7e7c6e` helper line. Used for empty rosters, no submissions, no participants, and the placeholder pages.

---

## 6. Iconography, motion, elevation

- **Icons:** [Tabler Icons](https://tabler.io/icons) webfont (`ti ti-*`, v3.31). Recurring set:
  `ti-pool` (brand), `ti-ticket` (omluvenky/credits), `ti-calendar` / `-calendar-check` / `-calendar-plus` /
  `-calendar-x`, `ti-check` / `-checks` / `-circle-check` / `-circle-check-filled`, `ti-x`, `ti-user-plus` /
  `-user-check` / `-user-shield` / `-user-search`, `ti-users` / `-friends`, `ti-search`, `ti-bell`,
  `ti-moon`, `ti-chevron-left/-right/-down`, `ti-arrow-left/-right` / `-arrow-back-up`, `ti-device-floppy`,
  `ti-qrcode`, `ti-forms`, `ti-inbox`, `ti-map-pin`, `ti-info-circle` / `-alert-circle`, `ti-download` /
  `-plus`, `ti-list` / `-calendar`, `ti-book` / `-books` / `-clipboard-check` / `-puzzle` / `-home`,
  `ti-refresh` / `-sparkles` / `-cake`. Course/category glyphs in the public form: `ti-bubble`, `ti-ripple`,
  `ti-fish`, `ti-swimming`, `ti-star`. Default icon color `#5c5b4f`; on fern surfaces `#588157`; sizes 14–24.
- **Motion:** restrained. `120ms` for control state (segmented, attendance toggles, chips), `140ms` for
  hover/transform (switch knob, toggle bg), `.2s` for progress fill. Hover = brightness on filled, bg shift
  on outline. No large entrance animations; respect `prefers-reduced-motion` (§7).
- **Elevation:** three steps only — flat (cards, `--shadow-card`), raised (modals/toasts, `--shadow-modal`),
  floating (phone, `--shadow-phone`). The translucent sticky header (`backdrop-blur(8px)`) reads as a fourth,
  ambient layer.

---

## 7. Accessibility

- **Contrast.** Primary ink `#1a2a21` on cream/white is ~13:1. The muted/secondary greys **pass AA for body
  text**: `#5c5b4f` ≈ 6.6:1, `#6f6e60` ≈ 5:1. `#7e7c6e` ≈ 4.0:1 — **use at ≥16px or 600‑weight (AA‑large)**,
  which is exactly how the mockups use it (11px 600 eyebrows, 13px headers); avoid it for long small body copy
  where `--color-text-muted` is the safer default. `#a3a294`/`#a8a698` are **decorative/placeholder only** and
  must never carry essential text. Status text on its own tint passes AA (e.g. `#803129` on `#f4e0db` ≈ 5.6:1;
  `#8a611a` on `#f6ead0` ≈ 4.8:1; `#3a5a40` on `#dde7d4` ≈ 5.9:1). Never signal state by fill alone — every
  status pill carries a label or icon (color‑blind safe).
- **Focus visibility.** Every interactive element shows the fern focus ring (`border #588157` +
  `--ring-focus`). Keep `:focus-visible` on; do not remove outlines on keyboard nav. The hidden native inputs
  behind custom checkboxes/toggles must still receive focus and toggle on Space/Enter.
- **Hit targets.** Controls are `38–50px` tall (filters 40, modal inputs/buttons 44, phone inputs/CTA 48–50,
  attendance toggles 38). The 32px letter/sort chips are the floor — keep ≥ 32px and never shrink touch
  targets below it on mobile.
- **Reduced motion.** Gate all transitions behind
  `@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`;
  progress/width changes become instant.
- **RTL / i18n.** Copy is bilingual (cs default, en) and strings are externalized (see [02](02-reservation-core.md) §13).
  Use logical properties (`margin-inline`, `padding-inline`, `inset-inline-start`) and `dir="rtl"`‑aware
  positioning for the search‑icon, select‑chevron, sidebar, and the week time‑axis so a future RTL locale
  mirrors cleanly. Numerics stay LTR even under RTL.

---

## 8. Responsive

Three surfaces, three stances — the tokens are shared, the chrome adapts.

- **Admin (desktop‑first).** Sidebar 248 + fluid content capped at `1240px`. Sticky `64px` translucent header
  `rgba(244,242,234,.85)` + `backdrop-blur(8px)` + `border-bottom #e2e0d6`. Filter rows wrap (`flex-wrap`);
  the attendance layout is a `1fr 312px` split that collapses to a single column under ~900px (summary card
  un‑sticks and moves below the roster). Below ~768px the sidebar becomes an off‑canvas drawer (same nav
  tokens) behind a hamburger; tables gain horizontal scroll within their card.
- **Portal (desktop‑first, fluid).** Header‑only (no sidebar); content capped at `1160px`. The controls card
  is a `1fr 300px` grid (age slider | toggle+legend) that stacks on narrow widths. The week calendar keeps its
  `60px + 6×` grid on desktop; on phones it switches to a vertical day‑by‑day list of slot blocks.
- **Public (mobile‑first).** Authored at `404px` inside a device frame for the mockup, but ships as a true
  responsive page: the phone "screen" becomes the full viewport, the faux status bar is dropped, and the
  sticky progress header + bottom nav bar persist as the wizard chrome. Single‑column throughout; `48–50px`
  controls; large tap targets and the GDPR/consent affordances stay thumb‑reachable above the footer CTA.

---

### Token quick‑reference

| Need | Token / value |
|---|---|
| App background | `--color-bg` `#f4f2ea` |
| Card | `#fff` · `border #e2e0d6` · `radius 14` · `--shadow-card` |
| Primary action | `--color-fern` `#588157` → hover `#487049` |
| Brand / sidebar | `--color-brand` `#344e41` |
| Focus ring | `border #588157` + `0 0 0 3px rgba(88,129,87,.18)` |
| Numbers | `--font-mono` + `.tnum` |
| Modal overlay | `rgba(37,56,46,.45)` |
| Toast | `bg #344e41` · `fg #f4f2ea` · icon `#a3b18a` |
