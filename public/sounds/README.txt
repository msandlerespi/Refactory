Drop notification sounds in this folder. Each one also needs an entry in the
SOUND_OPTIONS list at the top of public/app.js (file name + display label) to
show up in the join screen's dropdown. Keep them short — 1 to 3 seconds works
best.

If a selected file is missing or fails to decode, the app falls back to a
synthesized two-tone beep, so everything still works; it just won't be your
sound.
