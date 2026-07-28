import * as THREE from 'three';

/**
 * POST-PROCESSING — owned by the render builder.
 *
 * CONTRACT:
 *   createPostFX(ctx) -> {
 *     render() -> void          MUST draw the final image to the canvas
 *     setSize(w, h) -> void
 *     applyPalette(palette) -> void
 *     enabled: boolean
 *   }
 *
 * ctx = { renderer, scene, camera, palette }
 *
 * The default below is a passthrough. Anything added here (SSAO, bloom,
 * vignette, colour grade, FXAA, dithering) must keep the game at 60fps and
 * must not wash out the flat-shaded facets — they are the whole identity.
 */
export function createPostFX(ctx) {
  const { renderer, scene, camera } = ctx;
  return {
    enabled: false,
    render() {
      renderer.render(scene, camera);
    },
    setSize() {},
    applyPalette() {},
    setCamera(cam) {},
  };
}
