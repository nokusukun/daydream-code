# Design

## Visual Theme

A native macOS workspace. One window, two panels, no page routing: a translucent
sidebar over the desktop, an opaque content panel, and a command palette for
everything else.

Three rules govern the whole system:

1. **Glass is structure.** Translucency marks chrome that separates layers
   (toolbar, sidebar, composers, palette, popovers). Content surfaces are
   opaque so text legibility never depends on the wallpaper behind the window.
2. **Color comes from the OS.** The accent is the user's System Settings accent,
   read via `systemPreferences.getAccentColor()` and pushed to the renderer.
   Neutrals are mixed with a few percent of it, so the surface coheres with
   whatever the user picked rather than with a hardcoded blue.
3. **Everything degrades.** No vibrancy, reduced transparency, forced contrast,
   and reduced motion all have real fallbacks, not broken layouts.

Source of truth: `apps/desktop/src/styles.css`.

## Color

OKLCH throughout. No `#000`, no `#fff`, no untinted gray. Strategy is
**Restrained**: tinted neutrals carry the surface and the accent stays under
10%, reserved for selection, primary action, and live state.

### Runtime accent

`--accent` is set on `:root` from the main process and updated live when the
user changes their accent or theme (`apps/desktop/src/appearance.ts`).
`--accent-text` is computed in JS from the accent's relative luminance, because
macOS accents run from graphite to yellow and a hardcoded white would fail
contrast on the light ones.

The raw OS accent is tuned for macOS, not for WCAG (white on the default blue is
3.6:1), so two derived tokens exist and are what components actually use:

| Token | Use |
|---|---|
| `--accent` | Borders, focus rings, small indicators, veils |
| `--accent-solid` | Filled surfaces that carry text: selected rows, primary buttons, the send action |
| `--accent-ink` | The accent used *as text* on a surface: links, selected labels, checks |

### Token scales

| Role | Tokens |
|---|---|
| Surfaces | `--surface-0` (window) → `--surface-3` (hover), each accent-tinted |
| Text | `--text-1` (primary) / `--text-2` (secondary) / `--text-3` (tertiary) |
| Lines | `--hairline` (dividers), `--border` (controls) |
| Glass | `--glass-tint`, `--glass-tint-strong`, `--glass-specular`, `--glass-edge`, `--glass-shade` |
| Semantic | `--ok`, `--warn`, `--bad`, `--info` |

Three theme blocks define them: `:root, :root[data-theme="dark"]`,
`:root[data-theme="light"]`, and a `prefers-color-scheme: light` fallback for
`:root:not([data-theme])` (the renderer running in a plain browser, where no
bridge sets the attribute). **All three must stay in sync.**

### Contrast

Verified by rasterizing each rendered color over its real composited backdrop.
Every text surface clears WCAG AA in both themes: dark min 5.21:1, light min
4.76:1. Status is never color alone; each state also differs in shape (pulsing
ring, dot, rotated square, hollow ring) and carries a text label.

## Typography

| Role | Stack |
|---|---|
| UI | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif` |
| Code | `ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, monospace` |

Monospace is for machine content only: tool calls, journal payloads, raw event
lines. Chrome, labels, and prose are system sans. This split is the single
biggest reason the app reads as native rather than as a terminal in a window.

Fixed px scale, ratio ~1.15: `--text-xs` 10.5 / `--text-sm` 11.5 /
`--text-base` 13 / `--text-md` 15 / `--text-lg` 17 / `--text-xl` 22. Weights run
400–640; headings use 590 with `letter-spacing: -0.01em`. Numeric columns use
`font-variant-numeric: tabular-nums`.

## Layout

```
┌──────────────────────────────────────────────┐
│ toolbar (drag region, glass, 52px)           │
├───────────────────┬──────────────────────────┤
│ sessions (rail)   │                          │
│                   │   session panel          │
│ master thread     │   (opaque)               │
│  (scrolls)        │                          │
│                   ├──────────────────────────┤
│ dispatch composer │   message composer       │
└───────────────────┴──────────────────────────┘
```

- `.app` is a 2-row grid: toolbar / body.
- `.body` is a 2-column grid: `--sidebar-w` (340px) / `1fr`.
- `.sidebar` and `.panel` are each 3-row grids. **A component rendering into
  one must emit exactly three children**, or the scroller lands on an `auto`
  row and overflows. `SessionPanel` wraps its header, meta strip, and error bar
  in `.panel-top` for exactly this reason.
- Spacing scale `--s1`..`--s7` (4/8/12/16/22/32/48), used with deliberate jumps
  rather than uniformly.
- Radii `--r-sm` 5 / `--r-md` 8 / `--r-lg` 12 / `--r-xl` 18.
- Below 940px the sidebar narrows to 260px; below 720px it collapses and
  `.body.show-rail` toggles which pane is visible.

### Native window

`vibrancy: "sidebar"`, `visualEffectState: "followWindow"`,
`titleBarStyle: "hiddenInset"`, `trafficLightPosition: {x: 19, y: 18}`, and a
transparent `backgroundColor` so the material shows through. The toolbar is
`-webkit-app-region: drag` with `no-drag` on its controls. Off macOS the
renderer gets `.no-vibrancy` and paints opaque surfaces instead.

## Components

- **Not cards.** The master thread and a session transcript are the same
  timeline at two scales — one story per project, one story per run — and share
  one row shell (`views/Entry.tsx`): a standalone semantic icon, a kind label,
  a body. The session rail is a list of rows. At 200 entries, small icons and
  strong labels read where 200 boxes do not. Nested cards never appear.
- **Which side a message came from is a label, not a bubble.** The transcript
  says `REPLY` / `YOU` / `MASTER THREAD` against a semantic outline icon rather
  than alternating filled bubbles. Prose, tool traffic and lifecycle rows keep
  their rhythm without connector lines competing with dense tool output.
- **Transcript density is the hardest problem here.** A single turn in this repo
  ran 66 Bash calls, so the transcript has three levels of collapse:
  1. A run of consecutive tool events becomes one row: `29 tool calls ·
     Bash ×28, Agent`. It opens into a branch of the same timeline — child rows
     with their own icons, indented one gutter.
  2. Each call is one dense mono line with a preview, opening to its payload.
  3. Lifecycle events (`session_started`, `context_assembled`,
     `session_ended`) render as a dim line of prose (`· context assembled ·
     claude-opus-5[1m] · 60 tools`), never raw JSON, and open to the payload.
  A lone call skips level 1: one call is already quiet, and wrapping it would
  add a layer without removing noise.
- **Events with no text are not rendered.** Models that omit thinking still
  journal the event; an empty row is a hairline artifact.
- **`.transcript > *` and `.runs > *` set `flex: none`.** Flex items
  shrink by default, and in a tall transcript that squeezed single-line rows
  down to their own borders so they rendered as blank hairlines. Any new
  scroller built as a flex column needs the same rule.
- **Status** is a dot in the rail (shape-differentiated, pulsing when running)
  and a pill in the panel header.
- **The session strip** is one 44px row, never two bands: status dot, title,
  status pill, task, then the facts that move while you watch (provider mark,
  model, tokens, elapsed time), then actions. Exact timestamps and full token counts
  live in `title` attributes; the strip shows only what is glanceable, and
  drops the task then the facts as the window narrows.
- **Providers are marks, not words.** `ProviderIcon` renders the Anthropic and
  OpenAI marks monochrome from `currentColor`, so they read on glass, on the
  accent, and in both themes. Unknown drivers get a neutral glyph.
- **The model is always nameable.** A session that pinned no model still ran on
  one; the driver reports it in `context_assembled`, and the strip falls back
  to that before falling back to the driver's advertised default.
- **Buttons**: `.btn` base, with `.btn-primary` / `.btn-danger` / `.btn-quiet` /
  `.btn-icon`. 26px tall, `scale(0.97)` on press.
- **Loading** is a skeleton shaped like the content, never a centered spinner.
- **Empty states** teach the model (master thread, forking, the journal) rather
  than saying "nothing here."
- **Glass surfaces** use `.glass` or `.glass-strong`: a tint dense enough to
  keep contrast predictable, `backdrop-filter: blur() saturate() brightness()`,
  and an inset specular top edge. The sidebar adds an edge-lensing hairline on
  its trailing edge, which is what sells it as a pane rather than a blur.
- **Controls are the same material.** `--glass-control` / `--glass-control-hi`
  give buttons, the palette trigger, and the model trigger a translucent tint,
  a real blur, a specular top edge and a contact shadow. They are pills, not
  rectangles.
- **The composer floats.** It shares the scroller's grid row and sits at its
  end, so the transcript passes *underneath* it and its 40px backdrop-filter
  blurs real content. The transcript is masked top and bottom so text dissolves
  into the glass rather than colliding with it.
- **Specular highlights** mark every raised object: selected rows, status
  pills, palette rows, the app mark. The rule is an inset top hairline of white
  at low alpha, plus a contact shadow tinted by whatever the surface is (accent
  for selection, neutral for content).

### Grid discipline

`.panel` is a two-row grid and **every child must set `grid-column: 1`**.
Two children claiming the same row without an explicit column make CSS grid
invent a second column and place them side by side rather than stacking. That
bug shipped once already.

## Settings window

A second `BrowserWindow` (⌘, or the palette), loading the same bundle behind
`#view=settings`. A real window rather than a sheet or a pane: settings are not
one of the three co-visible jobs, and hiding a running session to change a token
budget is the navigation PRODUCT.md rules out.

```
┌──────────────────────────────────────────────┐
│ toolbar (glass, drag) · section · writing to │
├────────────────┬─────────────────────────────┤
│ source list    │  label ········ [control]   │
│  (glass)       │  help, provenance, status   │
│                │  ─────────────────────────  │
└────────────────┴─────────────────────────────┘
```

- **Rows, never cards**, like the rest of the app. Content caps at 760px: a
  label/control pair stops reading as a pair once the gap is wider than either
  half.
- **Curated sections carry what people change** (general, appearance, drivers,
  context, coordination, storage, network), grouped by what they affect rather
  than by which plugin owns them. **Plugins** is the honest full list: every
  composition row, its module in mono, its fiber state, and a generic editor for
  anything the curated sections do not claim.
- **Controls come from the plugin's own declaration** (`defineConfig`), so the
  label, help text, unit, and secret-ness are the plugin's, not the window's.
- **Provenance is always visible.** Each row says where its value came from —
  `default`, `bundle`, `user`, `project` — and only a value a writable layer set
  offers `reset`. "set in default" would be a contradiction; the four words are
  distinct on purpose.
- **Apply on commit** (blur or Enter), macOS-style. No global Save button: that
  is a web reflex, and the harness applies most changes live anyway. Text and
  number fields defer their write, because each commit can remount a plugin.
- **Saved is not the same as running.** A change the kernel will not hot-reload
  writes to disk, the control shows the new value, and a persistent bar names
  what is pending a relaunch. The row also reports what is still live, so the
  window never claims a value is running when it is not.
- Status is a dot plus a word, never colour alone: active (filled), pending
  (hollow ring), failed (rotated square), off (hollow, dim).

## Motion

Tokens: `--t-instant` 90ms / `--t-fast` 150ms / `--t-base` 220ms /
`--t-slow` 320ms, with `--ease-out-quart` and `--ease-out-expo`. No bounce, no
elastic, no layout-property animation.

Motion only conveys state: press feedback, hover, popover entry, the running
pulse, the streaming indicator, skeleton shimmer. Under
`prefers-reduced-motion` all of it stops, but liveness still reads: the running
dot keeps a static ring and the streaming dots hold a steady opacity.

## Accessibility

- WCAG 2.1 AA verified against composited backdrops in both themes.
- `prefers-reduced-transparency`: glass becomes opaque `--surface-0`.
- `prefers-contrast: more`: hairlines and borders strengthen, `--text-3`
  collapses into `--text-2`, glass goes opaque.
- `prefers-reduced-motion`: animations and transitions reduce to ~0.
- Focus is a 2px accent outline at 2px offset on every interactive element.
- Chrome is `user-select: none`; content areas opt back in, matching platform
  behavior.

## Anti-patterns

Do not add: side-stripe accent borders, gradient text, decorative blur on
content, identical card grids, hero-metric blocks, web-style nav tabs in the
header, or em dashes in UI copy.
