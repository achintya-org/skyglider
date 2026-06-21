# Horror background score

The game plays a cinematic horror score. By default it's **synthesised in the
engine** (Web Audio) — a dissonant drone + tritone, atonal high shimmer, wind,
a slow heartbeat and dissonant stingers through a convolution reverb. No asset,
works offline, no licensing concerns.

## Use a real licensed track instead

To play an actual professional horror track, supply an audio file — the engine
will use it and skip the synth automatically (and fall back to the synth if it
can't load):

1. **Drop a file here:** `audio/horror.mp3` (mp3/ogg/m4a all fine).
2. **Or point at a URL** (e.g. a royalty-free track you host): set
   `window.HORROR_MUSIC_URL = "https://…/track.mp3";` before `game.js` loads
   (e.g. add it in `firebase-config.js`).

Please use music you have the rights to — e.g. royalty-free / Creative-Commons
horror tracks (Kevin MacLeod's incompetech.com, Pixabay, etc. with attribution).
Commercial/film tracks are copyrighted and shouldn't be committed here.

A 🔊/🔇 button in the HUD mutes/unmutes either source.
