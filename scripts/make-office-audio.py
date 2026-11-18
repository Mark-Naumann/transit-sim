"""
scripts/make-office-audio.py
-----------------------------------------------------------------------------
Creates public/audio/office-quiet.mp3: a very quiet, gentle office ambience
(soft air-conditioning room tone + a little distant typing), 30 seconds long,
that loops smoothly. Made from scratch with math, so there are no copyright
or licensing questions.

Run with:  python3 scripts/make-office-audio.py      (needs numpy and ffmpeg)

How the smooth loop works: we shape the sound with an FFT (it turns sound into
a list of frequencies and back). The FFT treats the clip as a circle, so the
end flows straight into the beginning, with no click or gap when it repeats.
-----------------------------------------------------------------------------
"""

import os
import subprocess
import tempfile
import wave

import numpy as np

SAMPLE_RATE = 44100
SECONDS = 30
TARGET_RMS_DB = -42  # overall loudness (dB below full scale): very quiet
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "audio", "office-quiet.mp3")

rng = np.random.default_rng(seed=7)  # fixed seed = same file every time
n = SAMPLE_RATE * SECONDS


def shape(signal, gain_for_frequency):
    """Change how loud each frequency is (a filter), the loop-friendly way."""
    spectrum = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(len(signal), 1 / SAMPLE_RATE)
    return np.fft.irfft(spectrum * gain_for_frequency(freqs), n=len(signal))


# 1. Room tone: soft "air conditioning" noise.
#    Louder low frequencies, gentle roll-off of the highs (no harsh hiss),
#    and almost nothing below 50 Hz (no rumble).
def room_tone_gain(f):
    f = np.maximum(f, 1)
    pinkish = 1 / f**0.6                                  # softer, warmer noise
    no_rumble = 1 / (1 + (50 / f) ** 4)                   # cut below ~50 Hz
    no_hiss = 1 / (1 + (f / 1200) ** 3)                   # fade out above ~1.2 kHz
    hvac_whoosh = 1 + 1.5 * np.exp(-((f - 180) / 90) ** 2)  # gentle bump near 180 Hz
    return pinkish * no_rumble * no_hiss * hvac_whoosh


room = shape(rng.standard_normal(n), room_tone_gain)
room /= np.sqrt(np.mean(room**2))  # normalize to loudness 1.0

# 2. Distant typing: a few short bursts of soft key clicks.
typing = np.zeros(n)
click_length = int(0.012 * SAMPLE_RATE)  # each click lasts ~12 ms
t = np.arange(click_length) / SAMPLE_RATE
for burst_start in [3.0, 9.5, 17.0, 24.0]:  # seconds; kept away from the loop point
    time = burst_start
    for _ in range(rng.integers(6, 14)):  # 6-13 keystrokes per burst
        start = int(time * SAMPLE_RATE)
        click = rng.standard_normal(click_length) * np.exp(-t / 0.003)  # quick "tick"
        typing[start:start + click_length] += click * rng.uniform(0.4, 1.0)
        time += rng.uniform(0.12, 0.3)  # gap between keystrokes

# Make the clicks soft and far away: keep only the mid frequencies (~1-4 kHz).
typing = shape(typing, lambda f: np.exp(-((f - 2200) / 1500) ** 2))
typing /= np.max(np.abs(typing)) + 1e-12

# 3. Mix: typing is much quieter than the room tone.
mix = room + 0.9 * typing

# 4. Turn the whole thing down to the target (very quiet) loudness.
rms = np.sqrt(np.mean(mix**2))
mix *= 10 ** (TARGET_RMS_DB / 20) / rms
print(f"loudness {20 * np.log10(np.sqrt(np.mean(mix**2))):.1f} dBFS RMS, "
      f"peak {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS")

# 5. Save as WAV, then convert to MP3 with ffmpeg.
with tempfile.TemporaryDirectory() as tmp:
    wav_path = os.path.join(tmp, "office.wav")
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes())
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
                    "-codec:a", "libmp3lame", "-b:a", "96k", OUT], check=True)

print(f"saved {os.path.normpath(OUT)}")
