# ART DIRECTION v3 — THE REAL TARGET IS NOW ON DISK

**Read this before `BRIEF.md`. Then OPEN THE REFERENCE FILES AND LOOK AT THEM.**

```
ref/target_01_alpine_meadow.png       ref/target_05_winter_pass.png
ref/target_02_desert_canyon.png       ref/target_06_tropical_island.png
ref/target_03_alpine_lake_peaks.png   ref/target_07_volcanic_geothermal.png
ref/target_04_autumn_village.png      ref/target_08_blossom_wetland.png
```

These eight frames are the bar. `ref/reference_artofrally.png` is now only a
secondary note about camera discipline — **the eight targets win on every point
of disagreement.**

We keep art of rally's tilted world-fixed camera and flat-shaded, textureless
geometry. We reject its sparseness and its grey. The target is a **dense,
saturated, hand-painted low-poly diorama.**

---

## 1. The eight places

| File | Place | Signature content |
|---|---|---|
| 01 | **Alpine meadow** | Deep green grass, dense conifers, long timber bridge over a blue lake, deer, white flower clusters, double fence lines along the road |
| 02 | **Desert canyon** | Vermilion blocky sandstone, tall **timber trestle bridge** over a turquoise gorge, bighorn goats, saguaro + yucca, black-yellow chevron boards |
| 03 | **Alpine lake + peaks** | Stone arch bridge, snow-capped mountains on the horizon, deer and foxes, yellow/white flower meadows, red-white arrow signs. *The only frame where sky is visible.* |
| 04 | **Autumn village** | Red/orange/yellow broadleaf, red-roofed chalets, timber plank bridge, a waterfall and rapids, cows in a fenced paddock, golden field |
| 05 | **Winter pass** | Snow-laden conifers, stone-and-timber arch bridge, log cabin, deer, frozen turquoise water, **deep carved tyre ruts in the snow** |
| 06 | **Tropical island** | Palms, turquoise sea over pale sand, pink/red flowering shrubs, flamingos, a macaw in flight, deer, timber bridge over an inlet |
| 07 | **Volcanic geothermal** | Erupting geyser, turquoise hot spring, **glowing lava channels**, black basalt, rust-orange scrub, goats, an eagle, timber bridge over a gorge |
| 08 | **Blossom wetland** | Pink sakura, shallow teal water, a long timber jetty to a pagoda islet, red-crowned cranes, ducks, lily pads, deer |

Biomes **tropical**, **volcanic** and **blossom** are new and must be added.
Existing `coast` is retired in favour of `tropical`.

---

## 2. Camera — MEASURED FROM THE REFERENCES

- Car width in frame: **4.5–5.5%** (measured across all eight). Closer than
  art of rally's 3.7%, much closer than our current build.
- Tilt: **48–55°** from horizontal. Object flanks are clearly visible — you can
  read a bridge's pylons, a tree's cone sides, a cabin's walls.
- Real perspective recession, not orthographic. The far side of the frame is
  visibly deeper.
- **THE HORIZON IS USUALLY NOT IN FRAME.** Seven of the eight frames are filled
  edge to edge with ground and water; only `target_03` shows sky and distant
  peaks. Our current renders show far too much sky. Fix the pitch/distance so
  the ground fills the frame.
- Still **world-fixed heading** — the frame never rotates with the car.

## 3. The road is the hero shape

This is the single biggest compositional difference from our current build.

- Width **10–12 m** — a little over two car lengths. (Corrected: the first
  version of this spec said 12-20 m / three-to-five car lengths. That was
  estimated by eye and was wrong. Measured properly against target_01: the car
  reads ~5% of frame width at 4.5 m long, so 1% of frame is ~0.9 m; the road
  spans ~11% of frame width, giving ~10 m.)
- A pale warm ochre ribbon sweeping through the frame in long S-curves and
  hairpins, occupying a large fraction of the image.
- **2–4 darker parallel wheel ruts** curve along it. Highly visible and
  essential — they are what makes the road read as driven-on rather than painted.
  In snow (`05`) they are deep carved channels; in sand (`02`) faint arcs.
- Edges are **soft and irregular**: grass and pebbles encroach, no hard line.
- Roads fork and rejoin; a second road often runs through the background.

## 4. Mandatory recurring furniture

Present in nearly every reference. Their absence is the main reason a frame
reads as "procedurally generated" instead of "designed".

1. **Post-and-rail timber fences** following the road's curve, warm brown, often
   on both sides, sometimes running off over a hill. Partly buried in snow.
2. **Corner markers**: red-and-white striped vertical boards, red-white arrow
   signs, black-yellow chevron boards.
3. **Bridges as hero landmarks** — five distinct types across the set: long
   timber deck (01), tall timber trestle (02), stone arch (03), timber plank
   (04), stone-and-timber arch (05), plus a long **jetty** to an islet (08).
4. **Flower clusters** — white, yellow, red, pink — scattered densely in grass.
5. **Faceted boulders** in clusters, from pebble to larger-than-car, often
   half-buried, with flat-ish tops.
6. **A pale dust plume** trailing behind and beside the car, 2–3 car lengths
   long, soft and dissipating. Visible in all eight.
7. **Animals**, 4–15 per frame, roughly 1/3–1/2 car length.
8. **1–3 buildings** per scene maximum: chalet, cabin, pagoda, barn.

## 5. Surfaces and light

- **Grass is never flat**: tufts, darker patches, value variation, flower
  clusters. Same for sand and snow.
- **Trees**: layered cone tiers with visible facets, slightly rounded, darker
  core with lighter tips. Aggressive size variation — saplings through hero
  trees.
- **Shadows are SOFT and MEDIUM-LENGTH** (~1–1.5× object height), not the long
  hard shadows of art of rally. Objects are grounded by soft contact darkening
  at the base. **No crushed blacks** — shadow is a coloured step (blue in snow,
  warm in desert), never neutral black.
- **Water is the saturation anchor**: strong shallow→deep gradient, submerged
  rocks visible through it, **white foam rings around rocks and along shores**,
  rapids and waterfalls where it drops. Lily pads in still water.
- Overall grade: warm, high saturation, gentle bloom, soft high-key light,
  slight vignette. Painterly, never clinical.

## 6. Per-biome palette anchors

- **alpine** — grass `#5faa3c`→`#7cc24a`, conifer `#2f7d43`, lake `#1f7fd0`, road `#c9a45f`
- **alpineLake** — as alpine + peaks `#eef4fb` on `#8fa4bd`, water `#29a8e0`, flowers yellow/white
- **autumn** — road `#c9a45f`, grass `#8a9a3c`, foliage `#c0392b` `#e67e22` `#f1c40f`, roof `#b03a2e`, river `#3fb8d4`
- **desert** — sand `#e8a45c`, sandstone `#c0562f`→`#8a3520`, gorge water `#1fc4c4`, cactus `#5f8a4a`
- **winter** — snow `#f4f8fd`, shadow `#bcd6ef`, conifer `#1f4a3f`, ice `#5fd0e0`, timber `#a8763f`
- **tropical** — sand `#f0dcb0`, sea `#1fc8d8`→`#0a7fa8`, palm `#3f9a4a`, blooms `#ff4d8f`/`#ff8f3f`
- **volcanic** — basalt `#3a3a42`, scrub `#d4501e`/`#e8722a`, lava `#ff6b1a`→`#ffd23f` emissive, spring `#2fd0d8`
- **blossom** — sakura `#ffb7d5`/`#ff8fbf`, water `#4fd0d0`, grass `#6faa4a`, timber `#8a6a45`

## 7. Unchanged constraints

Flat shading, faceted geometry, **no textures and no image assets** — all
geometry procedural. Determinism via `src/core/rng.js`. 60 fps at 1920×1080,
instance everything. Camera never rotates with the car.

---

**Pass condition:** put your render beside the eight targets. It passes when it
would not be the obvious odd one out — same density, same saturation, same
road-as-hero composition, same soft high-key light, same furniture.
