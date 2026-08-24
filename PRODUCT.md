# Product

## Register

product

## Users

Developers running long-lived coding agents against their own repositories. Today that is the author and a small circle; the trajectory is a commercial product, so the interface has to survive a stranger's first launch without a tour.

The user sits in this app for hours, on a Mac, usually on a large display, often with a session working in the background while they read something else. They are never "browsing" it. They arrive with a job in hand.

Three jobs carry equal weight, and the interface must serve all three at once rather than optimizing for one:

1. Dispatch work (write a task, pick a driver and model, send it).
2. Monitor a running session (watch turns, tool calls, and output stream in; steer with a message).
3. Review the record (read the master thread as durable memory; dig back into the journal).

## Product Purpose

daydream-code is a coding harness built on a continuous journaled thread. Every project has one master thread; sessions fork it, run through a pluggable agent driver, and stream summaries back. Nothing is ever discarded: every tool call, turn, and thought lands in an append-only journal.

The desktop app is the window onto that model. Success is that a user can see, in one glance and without navigating, what is running, what it is doing right now, and what the project remembers.

The interface's hardest job is making a continuous, growing, machine-generated record feel legible and calm instead of like log spew.

## Brand Personality

Crisp, native, effortless.

The app should read as software Apple might have shipped: familiar rhythms, no invented chrome, zero friction, disappearing into the OS rather than announcing itself. Confidence is expressed through restraint and precision, never through decoration.

Voice is plain and lowercase-leaning, technical without jargon, and never cute. It states what happened. It does not narrate its own cleverness or use "magic" framing.

## Anti-references

All four are explicit rejections, confirmed by the user:

- **Generic dark IDE chrome.** VS Code clone: gray-on-gray panels, a tiny icon rail, a purple accent. The default reflex for anything developer-facing.
- **AI-startup purple gradients.** Gradient text, glowing orbs, sparkle icons, "magic" framing. The current wave of AI product cliche.
- **Frosted glass on everything.** Blur applied decoratively to every card and panel until nothing has hierarchy. This is the important one: the app wants macOS Liquid Glass, but as *structure*, not as texture.
- **Web dashboard in a window.** Bootstrap-shaped cards, web-style nav tabs, nothing that acknowledges it is a native desktop app.

## Design Principles

1. **Native first, web never.** Every decision answers to "would a Mac app do this?" Window chrome, sidebar behavior, focus rings, scroll physics, and keyboard paths follow platform convention rather than web habit. Nav tabs in a header bar are a web reflex and do not belong here.

2. **Glass is structure, not decoration.** Translucency and vibrancy mark the boundary between chrome and content: the sidebar, the toolbar, the composer. Content surfaces stay opaque and legible. If a blur is not separating a layer, it does not exist.

3. **Three jobs, one surface.** Dispatch, monitor, and review are co-visible. Navigation that hides one to show another is a failure, because it forces the user to hold state in their head.

4. **The record is the product.** The journal is lossless and the master thread is the project's memory. The interface should make that feel like an asset the user can lean on, not an exhaust log they scroll past.

5. **Density without noise.** This is an expert tool holding a lot of information. Earn density through hierarchy, typography, and rhythm rather than by shrinking everything uniformly or boxing each item in a card.

## Accessibility & Inclusion

- Target WCAG 2.1 AA. All text and meaningful UI meets AA contrast, including text sitting over translucent surfaces (verify against the darkest and lightest content that can scroll beneath).
- Honor `prefers-reduced-motion`: no transform or opacity transitions beyond instant state changes when set.
- Honor `prefers-reduced-transparency` and `prefers-contrast`: fall back to opaque surfaces with real borders.
- Full keyboard navigation with visible focus. No mouse-only affordances.
- Status is never encoded in color alone: running, completed, failed, and killed each carry a text label or shape difference.
