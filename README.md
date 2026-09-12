# Buzzr

See everyone else connected to the site, tap one, and their phone plays your
notification sound.

## Run it

```bash
npm install
npm start
```

The server prints a `Local:` URL for this machine and one or more `Network:`
URLs. Open a **Network** URL on any phone or laptop on the same Wi-Fi.

## Your sound

Copy your mp3 to `public/sounds/notify.mp3`. Until it's there, the app plays a
synthesized beep instead, so you can test without it.

## The feedback loop

Everyone carries a probability bar, 0–100, starting full.

1. Tapping someone's name buzzes them. Starting a chain by hand is free — only
   *receiving* costs anything.
2. Receiving a buzz costs the receiver `PROBABILITY_COST_PER_BUZZ` immediately —
   the bar drops as the phone rings.
3. **`FORWARD_DELAY_MS` after being notified**, that phone passes the chain on:
   one roll for every other person in the room — everyone except whoever just
   buzzed them — at odds equal to its remaining bar. At 60, each of those people
   has a 60% chance. Whoever gets hit does the same, one delay later.
4. Every `REGEN_TICK_MS`, everyone regains `PROBABILITY_REGEN_PER_TICK`, capped
   at 100.

Step 3 is what makes the cascade audible: each generation waits out the delay, so
the chain travels the room over seconds instead of firing at once. At the default
250 ms the generations run faster than the ~0.78 s sound, so hits overlap into a
wash; push the delay past the sound's length and the chain reads as distinct taps
instead.

A bar at 0 forwards nothing, so a chain always dies out; regeneration is what
makes the room able to ring again. Note the shape of it: the cost is per buzz
*received*, so being hit twice in one generation costs 20 — and each of those
hits forwards separately, which is how chains widen.

The knobs are at the top of `server.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `PROBABILITY_COST_PER_BUZZ` | `10` | Taken off the bar per buzz received. Lower = chains run longer and louder. |
| `PROBABILITY_REGEN_PER_TICK` | `5` | Added back each tick. Raise it past the cost and the room can sustain itself indefinitely. |
| `REGEN_TICK_MS` | `1000` | How often that regeneration happens. |
| `PROBABILITY_START` | `100` | Where everyone begins. |
| `PROBABILITY_MAX` | `100` | The ceiling, and the denominator for the odds. |
| `FORWARD_FALLBACK_MS` | `1000` | Safety net if a phone never reports back. Must exceed `FORWARD_DELAY_MS` plus a round trip. |

**The tempo knob lives on the client**, in `public/app.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `FORWARD_DELAY_MS` | `250` | How long a phone waits, from being notified, before passing the chain on. One generation per delay. |

### How a hop actually works

The notified phone waits `FORWARD_DELAY_MS`, then asks the server to roll for the
next hop. Keeping that trip on the wire is deliberate: each generation carries the
network's real latency on top of the timer, so the chain's timing is the room's
actual conditions rather than a number on the server. Measured on localhost, a
250 ms delay produced a 267 ms generation — the timer plus the round trip.

If a phone never reports — muted, backgrounded, closed, offline — the server
forwards on its behalf after `FORWARD_FALLBACK_MS` so one silent handset can't
kill the chain. The dice always stay on the server, so bars can't drift and a
client can't forward the same buzz twice.

Worth knowing before a room full of people: at the defaults, a single buzz among
four people at full bars produced **38 notifications over 2.3 seconds**. It
escalates faster than it reads — raise `PROBABILITY_COST_PER_BUZZ` to damp it,
lower it to make the room louder, and remember that shortening `FORWARD_DELAY_MS`
packs the same number of hits into less time.

Phones can also receive several buzzes in one generation, and at a 250 ms delay a
new buzz arrives long before the ~776 ms sound has finished. Both stack into
overlapping playback.

### Overlapping playback

One phone *can* play several copies at once — Web Audio mixes each buffer source
independently. Rendered offline, copies 250 ms apart measure:

| Simultaneous copies | Peak | RMS |
| --- | --- | --- |
| 1 | 0.2695 | 0.0265 |
| 2 | 0.3601 | 0.0375 |
| 4 | 0.3646 | 0.0530 |
| 8 | 0.3646 | 0.0750 |

RMS climbs as roughly √N — the signature of independent copies summing — and
nothing clips even at eight deep, since this sound peaks at 0.27.

`OVERLAP_SOUNDS` in `public/app.js` picks the behaviour:

| Value | Effect |
| --- | --- |
| `true` (default) | Buzzes layer. A busy phone thickens instead of restarting. |
| `false` | A new buzz cuts off whatever is playing. One sound at a time, every hit audible as a fresh attack. |

Verified live in both modes: with `true`, three buzzes 250 ms apart left three
sources sounding simultaneously; with `false`, the count never exceeded one.

## Tuning latency

The knobs live at the top of `public/app.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `TRIM_LEADING_SILENCE` | `true` | Skip silence at the head of the mp3. **This is the single biggest factor** — see below. |
| `SILENCE_THRESHOLD` | `0.001` | What counts as audible, as a fraction of full scale. Raise for files with a noise floor. |
| `PLAYBACK_LEAD_S` | `0` | Seconds added before the sound starts. `0` is as fast as possible; raising it only makes the hit later. |
| `AUDIO_LATENCY_HINT` | `'interactive'` | Asks the browser for the smallest output buffer. `'balanced'`/`'playback'` are larger but glitch less. |
| `VIBRATE_ON_BUZZ` | `true` | Set `false` to drop the vibration motor. |

The mp3 is fetched at page load and decoded into an `AudioBuffer` when you tap
Join, so a buzz costs only "make a node, start it" — no network, no decode, no
`HTMLAudioElement.play()` promise in the path.

### Check the file before blaming the network

Measured on this project, press-to-sound broke down as:

| Stage | Cost |
| --- | --- |
| Socket: press → `buzzed` at the receiver (localhost) | **0.5 ms** median |
| Browser audio stack (`baseLatency` + `outputLatency`) | **10 ms** |
| Silence at the head of `notify.mp3` | **1174 ms** |

Almost all of it was the file. The supplied mp3 runs 1.95 s but its first audible
sample is at 1.17 s, so every hit played a second of nothing first. Exported mp3s
carry this surprisingly often — check any sound before assuming the transport is
slow.

`TRIM_LEADING_SILENCE` handles it at playback time by starting at the first
audible sample, so it works for whatever file you drop in, without re-encoding.

Each device prints what it found, on join:

```
Sound ready. Output latency: 10 ms. Skipping 1174 ms of leading silence; 776 ms will play.
```

Read that on the actual phones. Output latency is the browser's audio stack and
no constant can shrink it — it's the floor, typically ~10 ms on desktop, higher
on phones. Total delay is roughly that plus one Wi-Fi hop.

## How it works

- `server.js` — Express serves `public/`, `ws` holds one WebSocket per user.
  The roster lives in memory; joining or leaving rebroadcasts it to everyone.
  Each client receives the roster minus itself.
- `public/app.js` — name entry, live user list, and playback of the incoming
  buzz. Receiving a buzz plays the sound and updates a quiet "Last buzz from …"
  line under the header; nothing covers the screen.

Messages are one-line JSON: client sends `join` and `buzz`, server sends
`welcome`, `users`, `buzzed`, `buzz-sent`, and `error`.

## Notes on phones

- **Sound needs one tap first.** Browsers block audio until the user interacts,
  so tapping **Join** primes the audio element. That's what the hint on the join
  screen is about.
- **The tab must stay open.** This uses in-page audio, not Web Push — a locked
  phone or a closed tab won't ring. (Adding Web Push later is a contained
  change: a service worker plus VAPID keys on the server.)
- **iPhone ring/silent switch** mutes web audio. Flip it to ring to hear the mp3.
- Reconnect is automatic with backoff if Wi-Fi drops.
- Buzzes are rate-limited to one per second per user.

## Firewall

On the first run, Windows may ask whether to let Node accept incoming
connections — allow it on **private networks**, or phones can't reach the
Network URL.
