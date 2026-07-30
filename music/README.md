# Your music goes here

Drop audio files into this folder and they become the in-game soundtrack.

    music/
      01 something.mp3
      02 something else.mp3

Supported: `.mp3`, `.ogg`, `.oga`, `.m4a`, `.aac`, `.wav`, `.flac`, `.webm` —
whatever your browser can decode. Tracks play in filename order, so numbering
them is the simplest way to set the running order. The name shown in-game is the
filename without its extension, with underscores turned into spaces.

If the dev server is already running, adding a file makes Vite reload the page
and the new track appears. Nothing else to configure — there is no playlist file
to edit.

## Controls

| Key | |
|---|---|
| `]` | next track |
| `[` | previous track |
| `P` | pause / resume |
| `=` / `-` | volume up / down |
| `N` | mute everything, music included |

Music starts when the race does — the same click or keypress that dismisses the
title screen. Browsers require a user gesture before any audio may play, so it
cannot begin earlier than that.

An empty folder is a perfectly normal state: the game simply runs without music.

## Note on committing audio

These files are yours, and they are large, so `music/*` is gitignored apart from
this README. Your tracks stay local.
