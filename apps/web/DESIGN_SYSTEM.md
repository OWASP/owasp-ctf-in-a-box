# OWASP CTF in a Box — Design System

A dark, cyberpunk-terminal aesthetic for the OWASP Capture The Flag site.
The look is "security operations console" — deep navy canvas, neon accents,
CRT scanlines, monospace terminal cues, and subtle glow/float motion.

---

## 1. Design Principles

- **Terminal-native.** Lean on monospace, command prompts, blinking cursors, and `$`/`init` language. The UI should feel like a hacker console, not a marketing page.
- **Dark by default.** There is no light theme. Everything sits on a near-black indigo canvas.
- **Neon accents, sparingly.** One dominant accent (blue) carries the brand. The other accents (red/yellow/teal/green) are semantic punctuation, not decoration.
- **Quiet motion.** Animations are slow, looping, and atmospheric (glow, float, scanline, cursor blink) — never attention-grabbing transitions.
- **Low-contrast chrome, high-contrast content.** Borders and overlays use white at 3–10% opacity; text and accents carry the contrast.

---

## 2. Color Tokens

### Surfaces
| Token | Hex | Usage |
|-------|-----|-------|
| `--background` | `#1a1a2e` | Page canvas (deep navy-indigo) |
| `--card-bg` | `#16162a` | Cards / raised panels |
| `--sidebar-bg` | `#12121e` | Sidebars, terminal prompt box, deepest surface |

### Text
| Token | Hex | Usage |
|-------|-----|-------|
| `--foreground` | `#d4d4d8` | Default body text (zinc-300) |
| `white` | `#ffffff` | Headings, emphasis |
| `zinc-400` | `#a1a1aa` | Secondary text |
| `--text-muted` | `#8f8f9b` | **Muted labels, terminal dim text.** Tailwind utility: `text-muted`. zinc-500 is only 3.5:1 on `--background` (3.3:1 inside the `bg-white/[0.03]` input fill) and fails WCAG AA for body-size text; this step is 4.9:1 on the worst surface and 5.3:1 on `--background`, while staying a clear tier below zinc-400 (6.5:1). |
| ~~`zinc-500`~~ | `#71717a` | **Do not use for text** — 3.5:1, fails AA. Use `--text-muted`. |
| `zinc-600` | `#52525b` | Separators and faint decorative detail (`·`, `→`) **only** — never text a reader needs. |

### Accents
| Token | Hex | Role |
|-------|-----|------|
| `--accent-blue` | `#2563eb` | **Primary brand** — title accent, cursor, dividers, borders, large/bold accents |
| `--accent-blue-link` | `#60a5fa` | **Inline text links.** `--accent-blue` is only 3.3:1 on `--background`, under the WCAG AA 4.5:1 floor for body-size text; this step is 6.7:1. Use the `.ds-link` class (colour **plus** a persistent underline) for any link inside a sentence — colour alone is 1.03:1 against zinc-400 body text and fails WCAG 1.4.1 Use of Color. Standalone chrome/nav links don't need the underline. |
| `--accent-teal` | `#14b8a6` | Secondary — eyebrow/subtitle text, "people" icon |
| `--accent-green` | `#22c55e` | Success / terminal prompt (`$`) |
| `--accent-yellow` | `#d4a017` | Warning / "shield" icon |
| `--accent-red` | `#e53e3e` | Danger / "clock" icon |

### Alpha overlays (chrome)
Use white at low opacity for borders, dividers, and glass surfaces:
- Border subtle: `rgba(255,255,255,0.06)` – `rgba(255,255,255,0.10)`
- Glass fill: `rgba(255,255,255,0.03)`
- Scanline lines: `rgba(255,255,255,0.04)` – `0.05`
- Accent dividers: blue at `20%`–`40%` opacity, faded to transparent on both ends.

---

## 3. Typography

Three Google fonts, loaded as CSS variables via `next/font`.

| Role | Font | Weights | Token |
|------|------|---------|-------|
| Headings (`h1`–`h6`) | **Poppins** | 400, 600, 700 | `--font-poppins` |
| Body / UI | **Barlow** | 300, 400, 500 | `--font-barlow` (`--font-sans`) |
| Code / terminal | **Geist Mono** | default | `--font-geist-mono` (`--font-mono`) |

### Type patterns
- **Display title (h1):** `text-5xl`→`sm:text-7xl`, `font-bold`, `tracking-tight`, white. Often paired with a colored accent character (e.g. `CTF @ <event>`, where `@` is blue).
- **Eyebrow / subtitle:** `text-lg`, `font-medium`, `uppercase`, `tracking-[0.25em]`, teal.
- **Section emphasis (e.g. "Coming Soon"):** `text-3xl`, `font-bold`, `uppercase`, `tracking-widest`, white.
- **Body / meta:** `text-sm`, zinc-400.
- **Labels:** `text-sm`, `text-muted`.
- **Terminal:** `font-mono`, `text-sm`, `text-muted` base with colored tokens.

---

## 4. Spacing & Layout

- **Centered single-column** hero layout: `flex flex-col items-center justify-center min-h-screen`.
- **Vertical rhythm:** primary content stack uses `gap-10`; tight groupings use `gap-3`/`gap-4`.
- **Horizontal padding:** `px-6` on content containers.
- **Layering:** background overlays at `z-10`, content at `z-20`. Decorative layers are `pointer-events-none`.
- **Radii:** `rounded-md` (badges), `rounded-lg` (terminal box), `rounded-full` (icon chips).

---

## 5. Components

### Icon chip
Circular, bordered, colored — used in a horizontal row to represent themes.
```
h-10 w-10, rounded-full, border-2 border-[accent], text-[accent],
flex items-center justify-center
```
20×20 stroke icons (`stroke-width: 2`, `fill: none`, `currentColor`). One chip per accent: red (clock), yellow (shield), blue (lock), teal (people).

### Badge / pill
```
rounded-md, border border-white/10, bg-white/[0.03], px-5 py-2.5
```
Label in `text-muted`, value in accent-blue `font-semibold`. (e.g. `Theme: <event theme>`)

### Gradient divider
A 1px horizontal rule that fades in from transparent:
```
h-px w-64 bg-gradient-to-r from-transparent via-[#2563eb]/40 to-transparent
```
A fainter variant (`via-[#2563eb]/20`) anchors the bottom of the page full-width.

### Terminal prompt box
The signature element:
```
rounded-lg, border border-white/[0.06], bg-[#12121e], px-6 py-3.5,
font-mono text-sm text-muted
```
- Green `$` prompt → zinc-400 command name → `text-muted` args.
- Trailing **blinking cursor**: `w-2` blue block, `blink 1s step-end infinite`.

### Scanline overlays
1. **Static CRT grid** — full-bleed, `opacity-[0.03]`, repeating 2px horizontal lines.
2. **Sweeping bar** — 1px white/4% bar animated top-to-bottom over 10s.

---

## 6. Motion

All animations are slow, infinite loops. Defined as keyframes; applied inline.

| Name | Effect | Timing | Applied to |
|------|--------|--------|-----------|
| `pulse-glow` | Blue text-shadow breathes (20→30px) | `4s ease-in-out infinite` | Display title |
| `float` | Translate Y 0 → −6px → 0 | `3s ease-in-out infinite` | "Coming Soon" |
| `blink` | Opacity 1 → 0 → 1 | `1s step-end infinite` | Terminal cursor |
| `scanline` | translateY −100% → 100vh | `10s linear infinite` | Sweeping CRT bar |

```css
@keyframes pulse-glow {
  0%, 100% { text-shadow: 0 0 20px rgba(37,99,235,.3), 0 0 40px rgba(37,99,235,.1); }
  50%      { text-shadow: 0 0 30px rgba(37,99,235,.5), 0 0 60px rgba(37,99,235,.2); }
}
@keyframes scanline { 0% { transform: translateY(-100%); } 100% { transform: translateY(100vh); } }
@keyframes blink    { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes float    { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
```

---

## 7. Voice & Content

- Use **terminal/CLI phrasing** for utility text: `ctf init --theme <event-theme>`. The pretend program is `ctf`, never the brand or the event name — a command with spaces in it reads as garbage, and the brand is a wordmark, which the header and footer already carry as `$ <event name>`.
- Dates as ranges with en-dashes: `Month D–D, YYYY`.
- Separate meta items with a muted middle-dot `·` (zinc-600).
- Security-domain iconography: clock, shield, lock, people.

---

## 8. Tech Stack Context

- **Framework:** Next.js 16 (App Router)
- **Styling:** Tailwind CSS v4 (`@import "tailwindcss"`, `@theme inline` token mapping)
- **Fonts:** `next/font/google` (Poppins, Barlow, Geist Mono)
- Tokens are declared on `:root` and exposed to Tailwind via `@theme inline`.
