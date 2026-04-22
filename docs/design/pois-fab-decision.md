# POI toggle: FAB vs side-menu — 2026-04-23

Peter asked whether the toilets + water toggles (currently in the side menu)
should move to a FAB on the map.

## Decision

**Stay in the side menu for now.** Revisit after a week of real use.

If mid-run toggling turns out to be frequent, build a **contextual status chip**
(shown only when POIs are enabled, near the distance pill) — not a FAB.

## Reasoning

### Pros of a FAB

- One-tap access vs two taps via the hamburger.
- Discoverability — users forget features buried in menus.
- Mental-model fit: POIs are a map *layer*, and layer toggles belong on the
  map, not in a settings panel.
- Thumb-reach on phone: bottom-right is natural for mid-run use.

### Cons of a FAB

- **Permanent clutter for an occasional need.** Most runners enable POIs
  once and leave them on. Dedicating a FAB for an infrequent toggle is
  expensive real estate.
- **Scale problem.** If toilets/water get a FAB, do units, gradient legend,
  and future layers each get one? Side menus scale; FAB stacks don't.
- **Two toggles = two FABs** (or a speed-dial with its own complexity).
  The servo UX review flagged bare-icon FABs as an antipattern — same trap
  here.
- **Bottom-right collides** with Leaflet attribution and the iPhone
  home-indicator gesture zone. Bottom-left competes with the elevation
  toggle.
- **Feature-creep magnet.** "We have a FAB for layers now" invites every
  future layer idea to ask for its own FAB.

### The middle option (build this if the side-menu toggle proves too slow)

When POIs are enabled, show a contextual pill-chip near the distance display
like `🚻 💧 ×`. One tap to hide. It is:

- Only visible when relevant — no permanent clutter.
- Discoverable — user just turned it on, they see where the "off switch"
  lives.
- Consistent with existing microcopy (pill-style, not a new primitive).
- ~15 lines of HTML/CSS/JS.

This is the pattern Google Maps uses for "Transit on" and Apple Maps for
"Satellite on" — a contextual status chip, not a permanent FAB.

## Related principle

The servo problem wasn't "no FAB" — it was "the only discovery path was a
bare icon with no label." Legwork's side-menu row already says
`🚻 Toilets` in plain English. The discovery problem is solved; the chip
is only needed if the *frequency* problem appears.

## Reconsider when

- Peter reports regularly opening the hamburger just to toggle POIs.
- A future tier-3 feature adds another map layer (favourites, water taps
  vs fountains, etc). At that point re-evaluate whether the chip pattern
  generalises to a small layers-panel instead of individual chips.
