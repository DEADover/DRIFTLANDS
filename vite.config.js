import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: ['.'] },
    /**
     * DO NOT RELOAD THE PAGE BECAUSE A DATA FILE MOVED.
     *
     * Vite watches the whole project and answers any change with a full page
     * reload. Everything this project does in the background writes into that
     * watch: `tools/progress.mjs rebuild` rewrites data.json and log.jsonl after
     * every logged event, every capture writes PNGs into shots/, the autosave
     * daemon commits on a timer, and the benches live under ab/. So the progress
     * page reloaded under the reader constantly — losing the open tab and the
     * scroll position, which made A/B vs Reference in particular almost unusable,
     * because it is the tab with the largest images and the most to look at.
     *
     * Source files are still watched, so editing the game still hot-reloads. What
     * is ignored here is only data and output: things the page reads on ITS OWN
     * schedule and should never be interrupted for.
     */
    watch: {
      ignored: [
        '**/progress/data.json',
        '**/progress/log.jsonl',
        '**/progress/autosave.json',
        '**/shots/**',
        '**/ab/**',
        '**/.git/**',
        // NOT music/ or sfx/. Those two are the one place a player is INVITED to
        // add files, and the whole promise is that dropping a track in and
        // letting the page reload is all it takes. Ignoring them here broke that
        // promise silently: the folder was emptied once to build a distributable
        // without redistributing someone's licensed music, Vite re-expanded the
        // glob with nothing in it, and then could not see the files come back.
        // The dev server served a music module with an empty playlist until it
        // was restarted, and nothing anywhere said so. They change rarely enough
        // that watching them costs no reloads worth having.
      ],
    },
  },
  /**
   * './' so the built game runs from a folder, not only from a web root — a
   * distributable that has to be served from '/' is a distributable most people
   * cannot open.
   */
  base: './',
  build: { target: 'es2022', sourcemap: false },
});
