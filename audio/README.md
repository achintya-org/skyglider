# Horror background score

The game plays a **real, same-origin track**: `audio/horror.wav`. This is the
only reliable path on iPhone — it loads with no CDN dependency, and HTML5 media
playback plays **through the iOS silent/ring switch** (the Web Audio synth
fallback does NOT; iOS mutes Web Audio when the ring switch is off).

`audio/horror.wav` is generated, royalty-free, and committed to the repo. It is
a seamless 30 s loop: a dissonant low drone + sub rumble, slow swells, atonal
high shimmer, wind, a slow double-thump heartbeat and reverberant minor-2nd
stingers. Regenerate it with:

```
node scripts/make-music.mjs
```

The track is fetched **only on the play gesture** (never at initial page load)
and is not in the service-worker precache, so it has zero impact on load time.

If the file can't load, the game falls back to a Web-Audio synth bed (works
offline, but obeys the iOS silent switch).

## Use a different track instead

1. **Replace the file:** drop your own `audio/horror.wav` (or `.mp3`) here.
2. **Or point at a URL:** set `window.HORROR_MUSIC_URL = "https://…/track.mp3";`
   before `game.js` loads (e.g. in `firebase-config.js`).

Please use music you have the rights to (royalty-free / Creative-Commons, or
your own). Commercial/film/streamed tracks are copyrighted — don't commit them.

A 🔊/🔇 button in the HUD mutes/unmutes the score.
