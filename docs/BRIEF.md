# DRIFTLANDS — shared brief

> ## ⚠ DIRECTION CHANGE — READ `docs/ART_DIRECTION.md` FIRST
>
> The client supplied eight new reference frames and the target moved upward.
> We keep art of rally's camera discipline and flat shading, but the world must
> now be **much denser, warmer and more saturated** — a hand-painted low-poly
> diorama, not a sparse grey hillside. The camera comes **closer and lower**,
> the **road becomes the hero shape**, and fences, chevron markers, bridges,
> flower patches, dust plumes and animals become mandatory recurring furniture.
> Three new biomes are added: volcanic, tropical, blossom.
>
> Where this file and `ART_DIRECTION.md` disagree, **ART_DIRECTION.md wins.**

Every builder and critic reads this first. It is the single source of truth for
what we are making and how we judge it.

## The bar (baseline discipline — see ART_DIRECTION.md for the current target)

**art of rally** (Funselektor). A 2.5D top-down driving game with a steeply
tilted, near-orthographic camera; flat-shaded untextured geometry; hard,
confident colour; enormous negative space; the car tiny in a huge landscape.

The reference frame is `ref/reference_artofrally.png`. Read it before you touch
anything. What it gets right, in priority order:

1. **Scale and sparsity.** The car is ~4% of the frame width. The ground is
   mostly empty. Props are placed in loose clusters with big gaps between —
   never uniform scatter. Emptiness is the composition, not a shortage of assets.
2. **Camera.** ~60° tilt from horizontal, narrow FOV, world-fixed heading (the
   frame does NOT rotate with the car). Objects read from above with just enough
   side visible to convey height.
3. **Value structure.** Long directional shadows are the main graphic element.
   They tie objects to the ground and describe the terrain's shape. The ground
   is a mid value; shadows are a clear step darker; the car pops as the lightest
   or most saturated thing in frame.
4. **Flat shading.** No textures anywhere. Hard facets. Silhouette does all the
   work. Every mesh is faceted and reads as a cut-paper shape.
5. **Restraint.** Two or three shapes repeated at varied scale and rotation.
   Detail lives in composition, not in polygons.

## Our difference

The reference is monochrome fog. **Ours must be vividly colourful and much
richer**: five distinct places, lakes, rivers, bridges, animals, villages,
route furniture. Richer in content — never busier in composition. If a change
makes the frame noisier without making it more legible, it is wrong.

**Match the reference on craft. Beat it on colour, life, and variety.**

## Non-negotiables

- Flat shading + vertex/instance colour. **No textures, no image assets.**
  Everything is procedural geometry and code. The project must stay
  self-contained.
- Determinism. All world generation goes through `src/core/rng.js` seeded from
  the biome seed. Never call bare `Math.random()` in world generation (FX and
  particles may, since they are not captured deterministically... but prefer
  seeded there too).
- Performance: 60 fps at 1920×1080. Keep draw calls under ~250; instance
  everything that repeats.
- The camera stays world-fixed by default (`followYaw = 0`). Do not make it
  chase the car's heading — that destroys the reference's poster quality.

## Architecture and file ownership

`src/game.js` is the wiring shell and is owned by the LEAD only. Every
subsystem lives behind a fixed interface documented as a `CONTRACT` comment at
the top of its module. **You edit only the files you own.** If you need a change
in `game.js`, say so in your report instead of editing it — the interface is
probably wrong, and that is worth knowing.

| Module | Owner role |
|---|---|
| `src/world/terrain.js`, `world/biomes.js`, `render/palette.js` | terrain & art direction |
| `src/world/roads.js` | roads |
| `src/world/water.js`, `world/bridges.js` | water & bridges |
| `src/world/props.js`, `world/landmarks.js` | vegetation & landmarks |
| `src/entities/animals.js` | wildlife |
| `src/entities/vehicle.js`, `entities/car.js`, `fx/feel.js` | driving & feel |
| `src/render/renderer.js`, `render/post.js`, `render/sky.js`, `render/camera.js` | rendering |
| `src/fx/particles.js`, `fx/skidmarks.js` | effects |
| `src/ui/hud.js`, `src/audio/audio.js` | HUD & audio |

## How to see your work

You have your own isolated copy of the repo and your own port. From your bench
directory:

```
npx vite --port <PORT> --strictPort &        # start once
node tools/shoot.mjs --base http://127.0.0.1:<PORT> --out shots/mine --hud 0
node tools/shoot.mjs hero_alpine drift_alpine --base http://127.0.0.1:<PORT> --out shots/mine --w 1920 --h 1080 --hud 0
```

Then **Read the PNGs**. You have vision — look at what you made, compare it to
`ref/reference_artofrally.png`, and iterate. A change you have not looked at is
not done. `shoot.mjs` exits non-zero on any page error, so a clean run also
means the build is not broken.

Capture presets live in `src/capture/presets.js`. Never change an existing
preset's meaning — critics compare the same preset across rounds. Add new ones
freely.

## Known defects in the v0 baseline

These are real and unfixed. Whichever is yours, fix it.

1. Terrain in the drivable interior is nearly flat — a billiard table. All the
   relief got pushed to the map rim.
2. Ground colour is one flat green; the altitude ramp never engages because the
   height range near the origin is tiny. No facets read at all.
3. Desert "mesa" terracing renders as a broken zigzag wall, not mesas.
4. No roads, bridges, landmarks or animals exist — those modules are stubs.
5. The drift model produces 2-4° of slip even under handbrake. There is no
   actual drifting. `drift_alpine` should show a big, obvious slide.
6. Prop collision hard-stops the car (three presets capture at 0 km/h). Props
   also spawn on top of the player's spawn point.
7. No post-processing: objects float, with no contact shading or grade.
8. Water meets land as a hard straight cut with no shoreline.
9. Trees are too few, too small, and too samey.

## SAVE YOUR WORK CONSTANTLY — this is not optional

Round 1 lost nine agents to a session limit mid-edit. Anything not written to
disk was gone. Two rules now:

1. **Write to disk early and often.** Never hold a large rewrite in your head
   across many tool calls. Land a working increment, shoot it, then improve it.
   A file that exists and renders beats a better file that never got written.
2. **Commit after every single iteration.** Your bench is a git repo. One line,
   costs nothing:

   ```
   git add -A && git commit -qm "what changed"
   ```

   Do it after each change→shoot→look cycle. If you are cut off, the lead
   recovers your last commit instead of losing the round.

A background autosave also snapshots your bench every 60 s, but that is a
backstop — your own commits carry the message describing what you tried, which
is what makes the history worth anything.

## Reporting

End your turn with a short structured report: what you changed, what the
screenshots show now, what is still wrong, and anything you need from another
owner. Be blunt about what you failed to fix.
