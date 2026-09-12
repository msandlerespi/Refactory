'use strict';

/* ==========================================================================
   Latency knobs — see README "Tuning latency".
   ========================================================================== */

// Seconds of lead time added before the sound starts. 0 = play as soon as the
// message arrives (lowest latency). Raise it only if you need to nudge the hit
// later; you cannot go below 0.
const PLAYBACK_LEAD_S = 0;

// 'interactive' asks the browser for the smallest output buffer it can manage.
// 'balanced' / 'playback' trade latency for power and glitch resistance.
const AUDIO_LATENCY_HINT = 'interactive';

// Exported mp3s very often carry silence at the head — the supplied notify.mp3
// had 1.17 s of it, which is pure delay on every single hit. Rather than require
// a trimmed file, playback starts at the first audible sample. Set false to play
// the file exactly as authored.
const TRIM_LEADING_SILENCE = true;

// Counts as audible, as a fraction of full scale. Raise it if a file has hiss or
// a noise floor before the sound proper.
const SILENCE_THRESHOLD = 0.001;

// Kept in front of the first audible sample so the attack isn't clipped.
const ATTACK_GUARD_S = 0.005;

// How long this phone waits, from the moment it is notified, before telling the
// server to pass the chain on. This is the tempo of the instrument: one
// generation per FORWARD_DELAY_MS, plus the real network round trip.
//
// Independent of the sound's length. Below the ~0.78 s of audible notify.mp3,
// generations overlap and the room builds into a wash; above it, each hit lands
// in silence and the chain reads as distinct taps.
const FORWARD_DELAY_MS = 250;

// true:  a buzz layers on top of whatever is still ringing. Web Audio mixes them,
//        so four overlapping copies measure ~2x the RMS of one.
// false: a new buzz cuts off whatever is playing and starts over, so a phone only
//        ever makes one sound at a time.
const OVERLAP_SOUNDS = true;

// Vibration is a separate motor and adds mechanical noise. Set false to silence.
const VIBRATE_ON_BUZZ = true;
const VIBRATE_PATTERN = [200];

const SOUND_URL = 'sounds/notify.mp3';

/* ========================================================================== */

const $ = (id) => document.getElementById(id);

const joinScreen = $('join-screen');
const appScreen = $('app-screen');
const joinForm = $('join-form');
const nameInput = $('name-input');
const meName = $('me-name');
const statusDot = $('status-dot');
const onlineCount = $('online-count');
const userList = $('user-list');
const emptyState = $('empty-state');
const lastBuzz = $('last-buzz');
const myMeter = $('my-meter');
const myValue = $('my-value');
const toast = $('toast');

const AVATAR_COLORS = ['#6c5cff', '#ff6b6b', '#2fb8a4', '#f0a33a', '#4ad1ff', '#d466d8', '#7bc043'];

let socket = null;
let myName = '';
let myId = null;
let reconnectDelay = 500;
let toastTimer = null;

/* ---------- Sound ----------
   The mp3 is fetched at page load and decoded into memory the moment audio is
   unlocked, so a buzz costs only "create a node and start it" — no network, no
   decode, no HTMLAudioElement play() promise on the critical path. */

let audioCtx = null;
let notifyBuffer = null;
let encodedSound = null; // ArrayBuffer, fetched before the context exists
let soundOffsetS = 0; // where in the buffer the audible part begins

/** Seconds of silence at the head of the buffer, across all channels. */
function findLeadingSilence(buffer) {
  let earliest = Infinity;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > SILENCE_THRESHOLD) {
        if (i < earliest) earliest = i;
        break;
      }
    }
  }

  if (earliest === Infinity) return 0; // silent file; play it as-is
  return Math.max(0, earliest / buffer.sampleRate - ATTACK_GUARD_S);
}

const soundFetch = fetch(SOUND_URL)
  .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
  .then((bytes) => {
    encodedSound = bytes;
  })
  .catch(() => {
    console.warn(`${SOUND_URL} not found — falling back to a synthesized beep.`);
  });

// Mobile browsers only allow audio that a user gesture started, so this runs
// inside the Join tap.
function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;

  if (!audioCtx) audioCtx = new Ctx({ latencyHint: AUDIO_LATENCY_HINT });
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // Starting a silent buffer in the gesture is what actually opens the output
  // on iOS; without it the first real sound can be swallowed.
  const silent = audioCtx.createBufferSource();
  silent.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
  silent.connect(audioCtx.destination);
  silent.start(0);

  soundFetch.then(() => {
    if (!encodedSound || notifyBuffer) return;
    // decodeAudioData detaches the buffer, so hand it a copy.
    audioCtx.decodeAudioData(encodedSound.slice(0)).then(
      (buffer) => {
        notifyBuffer = buffer;
        soundOffsetS = TRIM_LEADING_SILENCE ? findLeadingSilence(buffer) : 0;

        const outputMs = Math.round((audioCtx.baseLatency + (audioCtx.outputLatency || 0)) * 1000);
        console.info(
          `Sound ready. Output latency: ${outputMs} ms. ` +
            `Skipping ${Math.round(soundOffsetS * 1000)} ms of leading silence; ` +
            `${Math.round((buffer.duration - soundOffsetS) * 1000)} ms will play.`
        );
      },
      () => console.warn(`Could not decode ${SOUND_URL} — falling back to a beep.`)
    );
  });
}

// Used when notify.mp3 is missing or undecodable.
function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime + PLAYBACK_LEAD_S;
  [0, 0.22].forEach((offset) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now + offset);
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.3, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.2);
  });
}

/** Sources currently sounding, so OVERLAP_SOUNDS = false can cut them off. */
const activeSources = new Set();

function playNotification() {
  if (audioCtx && notifyBuffer) {
    if (!OVERLAP_SOUNDS) {
      for (const playing of activeSources) {
        // Already-finished sources throw; harmless either way.
        try {
          playing.stop();
        } catch {}
      }
      activeSources.clear();
    }

    const source = audioCtx.createBufferSource();
    source.buffer = notifyBuffer;
    source.connect(audioCtx.destination);
    source.onended = () => activeSources.delete(source);
    activeSources.add(source);
    // Second argument is where to begin *within* the buffer — this is the trim.
    source.start(audioCtx.currentTime + PLAYBACK_LEAD_S, soundOffsetS);
  } else {
    beep();
  }

  // After the sound is scheduled, so it never delays playback.
  if (VIBRATE_ON_BUZZ && navigator.vibrate) navigator.vibrate(VIBRATE_PATTERN);
}

/* The chain advances from here. This phone waits FORWARD_DELAY_MS, then asks the
   server to roll the dice for the next hop — so every generation costs the real
   trip out and back, not just the timer. If this phone never reports (muted,
   closed, offline) the server's own fallback covers it. */
function forwardChain(buzzId) {
  if (!buzzId) return;

  setTimeout(() => {
    // Deliberately quiet: a dropped forward should not raise a toast.
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'forward', buzzId }));
    }
  }, FORWARD_DELAY_MS);
}

// A backgrounded tab can suspend the context; bring it back on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
});

/* ---------- UI helpers ---------- */

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function avatarColor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(name) {
  return [...name.trim()][0]?.toUpperCase() ?? '?';
}

function setMeter(fill, probability) {
  fill.style.width = `${probability}%`;
  fill.classList.toggle('empty', probability === 0);
}

/* The roster arrives every second, so rows are updated in place rather than
   rebuilt — rebuilding would churn the DOM and wipe the "Sent ✓" state
   mid-animation. */

const rows = new Map(); // id -> { li, nameEl, fillEl, valueEl }

function createRow(user) {
  const button = document.createElement('button');
  button.type = 'button';

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.style.background = avatarColor(user.id);
  avatar.textContent = initials(user.name);

  const main = document.createElement('span');
  main.className = 'user-main';

  const nameEl = document.createElement('span');
  nameEl.className = 'user-name';

  const meter = document.createElement('span');
  meter.className = 'meter';
  const fillEl = document.createElement('span');
  fillEl.className = 'meter-fill';
  meter.append(fillEl);
  main.append(nameEl, meter);

  const valueEl = document.createElement('span');
  valueEl.className = 'meter-value';

  const label = document.createElement('span');
  label.className = 'buzz-label';
  label.textContent = 'Buzz';

  button.append(avatar, main, valueEl, label);
  button.addEventListener('click', () => {
    send({ type: 'buzz', to: user.id });
    label.textContent = 'Sent ✓';
    button.classList.add('sent');
    setTimeout(() => {
      label.textContent = 'Buzz';
      button.classList.remove('sent');
    }, 1500);
  });

  const li = document.createElement('li');
  li.append(button);
  return { li, nameEl, fillEl, valueEl };
}

function renderUsers(users) {
  const seen = new Set();

  for (const user of users) {
    if (user.id === myId) {
      setMeter(myMeter, user.probability);
      myValue.textContent = user.probability;
      continue;
    }

    seen.add(user.id);
    let row = rows.get(user.id);
    if (!row) {
      row = createRow(user);
      rows.set(user.id, row);
      userList.append(row.li);
    }

    if (row.nameEl.textContent !== user.name) row.nameEl.textContent = user.name;
    setMeter(row.fillEl, user.probability);
    row.valueEl.textContent = user.probability;
  }

  for (const [id, row] of rows) {
    if (seen.has(id)) continue;
    row.li.remove();
    rows.delete(id);
  }

  emptyState.hidden = seen.size > 0;
  onlineCount.textContent = seen.size
    ? `${seen.size} other${seen.size === 1 ? '' : 's'} online`
    : '';
}

/* ---------- Connection ---------- */

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  } else {
    showToast('Reconnecting…');
  }
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${scheme}://${location.host}`);

  socket.addEventListener('open', () => {
    reconnectDelay = 500;
    statusDot.classList.remove('offline');
    socket.send(JSON.stringify({ type: 'join', name: myName }));
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'welcome':
        myId = msg.id;
        myName = msg.name;
        meName.textContent = msg.name;
        localStorage.setItem('buzzr:name', msg.name);
        break;
      case 'users':
        renderUsers(msg.users);
        break;
      case 'buzzed':
        playNotification(); // first, before any DOM work
        forwardChain(msg.buzzId);
        lastBuzz.textContent = `Last buzz from ${msg.from.name}`;
        break;
      case 'buzz-sent':
        showToast(`Buzzed ${msg.to.name}`);
        break;
      case 'error':
        showToast(msg.message);
        break;
    }
  });

  socket.addEventListener('close', () => {
    statusDot.classList.add('offline');
    onlineCount.textContent = 'reconnecting…';
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });
}

/* ---------- Start ---------- */

nameInput.value = localStorage.getItem('buzzr:name') || '';

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;

  unlockAudio(); // must happen inside this gesture
  myName = name;
  meName.textContent = name;
  joinScreen.hidden = true;
  appScreen.hidden = false;
  connect();
});

$('test-sound').addEventListener('click', () => {
  if (!audioCtx) unlockAudio();
  playNotification();
});
