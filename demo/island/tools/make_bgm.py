#!/usr/bin/env python3
"""Synthesises the island's background music: a slow music-box tune over a
soft pad, written here note by note and rendered to a loop that joins
itself without a click. Run: python3 tools/make_bgm.py"""
import math, pathlib, struct, wave

RATE = 22050
BPM = 76
BEAT = 60 / BPM
BARS = 8
LENGTH = int(BARS * 4 * BEAT * RATE)
TARGET = pathlib.Path(__file__).resolve().parent.parent / "assets" / "audio" / "bgm.wav"

NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def freq(name):
    return 440 * 2 ** ((NOTE[name[0]] + 12 * (int(name[1]) - 4) - 9) / 12)


mix = [0.0] * LENGTH


def add(start_beat, name, kind, beats=1.0, gain=1.0):
    f = freq(name)
    start = int(start_beat * BEAT * RATE)
    if kind == "box":       # a struck tine: bright at first, then a long sine tail
        total = int(2.6 * RATE)
        for i in range(total):
            t = i / RATE
            env = math.exp(-t * 2.4) * min(1.0, t * 400)
            s = math.sin(math.tau * f * t) + 0.35 * math.exp(-t * 7) * math.sin(math.tau * f * 3.01 * t) \
                + 0.2 * math.exp(-t * 4) * math.sin(math.tau * f * 2 * t)
            mix[(start + i) % LENGTH] += s * env * 0.22 * gain
    elif kind == "pad":     # two slightly detuned sines that swell and fade
        total = int((beats * BEAT + 1.2) * RATE)
        hold = beats * BEAT
        for i in range(total):
            t = i / RATE
            env = min(1.0, t / 0.9) * (1.0 if t < hold else max(0.0, 1 - (t - hold) / 1.2))
            s = math.sin(math.tau * f * t) + math.sin(math.tau * f * 1.004 * t) + 0.3 * math.sin(math.tau * f * 2 * t)
            mix[(start + i) % LENGTH] += s * env * 0.05 * gain
    elif kind == "bass":
        total = int((beats * BEAT + 0.4) * RATE)
        for i in range(total):
            t = i / RATE
            env = min(1.0, t * 30) * math.exp(-t * 1.1)
            mix[(start + i) % LENGTH] += math.sin(math.tau * f * t) * env * 0.2 * gain


# Eight bars: C, Am, F, G, C, Am, F, G(sus). Chords as pads, roots as bass.
CHORDS = [("C3", ["C4", "E4", "G4"]), ("A2", ["A3", "C4", "E4"]), ("F2", ["F3", "A3", "C4"]), ("G2", ["G3", "B3", "D4"])] * 2
for bar, (root, chord) in enumerate(CHORDS):
    add(bar * 4, root, "bass", 3.5)
    add(bar * 4 + 2.5, root, "bass", 1, 0.6)
    for name in chord:
        add(bar * 4, name, "pad", 4)

# The tune, in the pentatonic scale so that any two notes get along: (beat, note).
TUNE = [
    (0, "E5"), (1, "G5"), (1.5, "A5"), (2.5, "G5"), (3.5, "E5"),
    (4, "C5"), (5, "E5"), (5.5, "D5"), (6.5, "C5"), (7.5, "A4"),
    (8, "C5"), (9, "A4"), (9.5, "C5"), (10.5, "D5"), (11.5, "E5"),
    (12, "D5"), (13.5, "G4"), (14.5, "B4"), (15.5, "D5"),
    (16, "E5"), (17, "G5"), (17.5, "A5"), (18.5, "C6"), (19.5, "A5"),
    (20, "G5"), (21, "E5"), (21.5, "D5"), (22.5, "C5"), (23.5, "E5"),
    (24, "A5"), (25, "G5"), (25.5, "E5"), (26.5, "C5"), (27.5, "D5"),
    (28, "D5"), (29.5, "G4"), (30.5, "A4"), (31.5, "D5"),
]
for beat, name in TUNE:
    add(beat, name, "box")
    add(beat + 0.02, name[0] + str(int(name[1]) + 1), "box", gain=0.12)   # a shimmer an octave up

peak = max(abs(v) for v in mix)
scale = 0.7 * 32767 / peak
with wave.open(str(TARGET), "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(RATE)
    out.writeframes(b"".join(struct.pack("<h", int(v * scale)) for v in mix))
print(f"wrote {TARGET} ({TARGET.stat().st_size // 1024} KB, {LENGTH / RATE:.1f} s)")
