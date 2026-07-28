# ART DIRECTION v2 — THIS SUPERSEDES THE art-of-rally-ONLY BAR

**Read this before `BRIEF.md`. The target has changed and it changed upward.**

The client supplied eight new reference frames. They are not on disk — they were
supplied visually and transcribed here by the lead. This document IS the
reference. Treat every number in it as a spec, not a suggestion.

The new bar keeps art of rally's *camera and flat-shaded discipline* but
replaces its sparse monochrome minimalism with something **far richer, denser,
warmer and more saturated** — a hand-painted low-poly diorama. Think
"Monument Valley meets a rally stage", not "foggy grey hillside".

---

## 1. The eight reference scenes

| # | Place | Signature content |
|---|---|---|
| 1 | **Autumn village** | Red/orange/yellow broadleaf, red-roofed chalets, timber plank bridge over a rapids river, cows in a fenced paddock, post-and-rail fences, wide ochre dirt road |
| 2 | **Alpine meadow** | Deep green grass, dense conifers, long timber bridge over a blue lake, deer, white/red wildflower patches, fences following the road |
| 3 | **Alpine lake + snow peaks** | Stone arch bridge, snow-capped mountains on the horizon, deer and foxes, yellow/white flower meadows, red-white chevron markers |
| 4 | **Desert canyon** | Vermilion stepped sandstone, **tall timber trestle bridge** over a turquoise gorge, bighorn goats, saguaro + yucca, black-yellow chevron signs, teal car |
| 5 | **Winter pass** | Snow-laden conifers, stone-and-timber arch bridge, log cabin, deer, frozen turquoise water, **visible tyre tracks carved in snow** |
| 6 | **Volcanic / geothermal** | Erupting geyser, turquoise hot springs, **glowing lava channels**, black basalt, rust-orange scrub, goats, soaring eagle, timber bridge over a gorge |
| 7 | **Tropical island** | Palm trees, turquoise sea over sand, pink/red flowering shrubs, flamingos, a macaw in flight, deer, timber bridge over an inlet |
| 8 | **Cherry-blossom wetland** | Pink sakura, shallow teal water, long timber jetty, a pagoda on an islet, red-crowned cranes, ducks, deer |

**Biomes 6, 7 and 8 are new** and must be added: `volcanic`, `tropical`,
`blossom`. Together with `autumn`, `alpine`, `alpineLake`, `desert`, `winter`
that is eight distinct places.

---

## 2. Camera — CHANGED

Lower and closer than art of rally.

- Car occupies **5–7% of frame width** (was 3.5–4.5%). Reduce `distance` accordingly.
- Tilt **50–58°** from horizontal (was 61°). We see more of the sides of objects;
  trees show their cone flanks, bridges show their pylons and understructure.
- FOV stays narrowish (**26–32°**) — the diorama compression must survive.
- Still **world-fixed heading**. Do not chase the car's yaw.
- Slight but real perspective recession: the far edge of the frame reads deeper.

## 3. Composition — CHANGED

art of rally's emptiness is gone. The new frames are **dense but legible**.

- The **road is the hero shape**: a wide (10–14 m) pale ochre ribbon sweeping in
  S-curves and hairpins across the whole frame. It carves the negative space —
  the road, not empty ground, is what gives the eye rest.
- **Darker wheel ruts** run along the road, curving with it. Highly visible.
  In snow they are carved channels showing blue-grey beneath.
- Vegetation density near the road is **high**: trees, bushes, rocks, flower
  patches, grass tufts. Big empty meadow patches still exist, but between
  clusters — not as the dominant note.
- Layered depth: foreground rocks/trees, mid-ground road + car, background
  water or mountains. Most frames have water occupying 20–40% of the frame.

## 4. Colour and light — CHANGED

- **Highly saturated, warm, painterly.** Strong local colour. Nothing muted,
  nothing grey, nothing washed out.
- **Water is the saturation anchor**: vivid cyan → turquoise → deep blue, with
  white foam at shores, rocks and rapids. In desert and tropical it is almost
  unreally cyan. This is a signature — get it right.
- Sun is **high and soft**. Shadows are SHORT and SOFT, not the long hard
  shadows of art of rally. Objects are grounded by a soft contact/AO darkening
  at their base rather than by a long cast shadow.
- Overall key is bright and high. Avoid crushed blacks; shadow is a coloured
  step (blue in snow, warm in desert), never neutral grey.

## 5. Mandatory recurring props

These appear in nearly every reference and are the visual glue. Missing them is
the single most likely reason our frames will read as "generated":

1. **Post-and-rail timber fences** that follow the road's curve — everywhere.
2. **Red-and-white striped corner markers** and **black-yellow chevron boards**
   on the outside of corners.
3. **Bridges as hero landmarks** — at least five distinct types: timber plank,
   long timber span, stone arch, tall timber trestle, jetty/pier.
4. **Flower patches** — white, yellow, red, pink — scattered in meadows.
5. **Faceted boulders**, often clustered, sized from pebble to car-sized.
6. **A dust plume** behind the car: pale, soft, billowing, clearly visible.
7. **Animals**, 6–15 visible per frame, at roughly 1/3–1/2 car length.
8. **1–3 buildings** per scene, never more: chalet, cabin, pagoda, ruin.

## 6. Per-biome palette targets

Approximate anchors; tune by eye against the descriptions above.

- **autumn** — road `#c9a45f`, grass `#8a9a3c`/olive, foliage `#c0392b` `#e67e22` `#f1c40f`, roof `#b03a2e`, river cyan `#3fb8d4`
- **alpine** — grass `#5faa3c`→`#7cc24a`, conifer `#2f7d43`, lake `#1f7fd0`, flowers white/red
- **alpineLake** — as alpine + snow peaks `#eef4fb` on `#8fa4bd` rock, water `#29a8e0`
- **desert** — sand `#e8a45c`, sandstone `#c0562f`→`#8a3520`, gorge water `#1fc4c4`, cactus `#5f8a4a`
- **winter** — snow `#f4f8fd` with blue shadow `#bcd6ef`, conifer `#1f4a3f`, ice `#5fd0e0`
- **volcanic** — basalt `#3a3a42`, scrub `#d4501e`/`#e8722a`, lava `#ff6b1a`→`#ffd23f` emissive, spring `#2fd0d8`
- **tropical** — sand `#f0dcb0`, sea `#1fc8d8`→`#0a7fa8`, palm `#3f9a4a`, blooms `#ff4d8f`/`#ff8f3f`
- **blossom** — sakura `#ffb7d5`/`#ff8fbf`, shallow water `#4fd0d0`, grass `#6faa4a`, timber `#8a6a45`

## 7. What has NOT changed

- Flat shading, faceted geometry, **no textures, no image assets**, everything
  procedural.
- Determinism through `src/core/rng.js`.
- 60 fps at 1920×1080, instance everything.
- The camera does not rotate with the car.

---

**Judgement rule for this round:** a frame passes when it could sit in the
supplied set of eight without looking like the odd one out — same density, same
saturation, same road-as-hero composition, same soft high-key light.
