# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

"""Explicit local speech inference; no product policy or transport."""
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
import subprocess
import tempfile
import wave


class FailureCode(StrEnum):
    INVALID_INPUT = "invalid_input"
    UNAVAILABLE = "unavailable"
    TIMEOUT = "timeout"
    FAILED = "failed"
    OUTPUT_LIMIT = "output_limit"


class SpeechFailure(Exception):
    def __init__(self, code: FailureCode):
        self.code = code
        super().__init__(code.value)


@dataclass(frozen=True)
class SpeechLimits:
    timeout_seconds: float
    max_duration_seconds: float
    max_wav_bytes: int

    def __post_init__(self):
        import math
        if (not math.isfinite(self.timeout_seconds)
                or not math.isfinite(self.max_duration_seconds)
                or self.timeout_seconds <= 0
                or self.max_duration_seconds <= 0
                or type(self.max_wav_bytes) is not int
                or self.max_wav_bytes <= 0):
            raise ValueError("invalid speech limits")


class Piper:
    """One configured executable, caller-selected model, one bounded result.

    The caller owns scheduling, model provenance, admission and output format.
    Files exist only inside the invocation's temporary directory. No network
    or executable/model download is performed by this adapter.
    """

    def __init__(self, executable: Path):
        self.executable = executable.resolve()
        if not self.executable.is_file():
            raise SpeechFailure(FailureCode.UNAVAILABLE)

    def synthesize(self, text: str, model: Path, limits: SpeechLimits) -> bytes:
        if not isinstance(text, str) or not text.strip() or "\x00" in text or "[[" in text:
            raise SpeechFailure(FailureCode.INVALID_INPUT)
        try:
            data = text.encode("utf-8")
        except UnicodeError:
            raise SpeechFailure(FailureCode.INVALID_INPUT) from None
        model = model.resolve()
        if not model.is_file() or not Path(str(model) + ".json").is_file():
            raise SpeechFailure(FailureCode.UNAVAILABLE)
        try:
            with tempfile.TemporaryDirectory(prefix="aiai-speech-") as directory:
                output = Path(directory) / "speech.wav"
                subprocess.run(
                    [str(self.executable), "-m", str(model), "-f", str(output)],
                    input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=limits.timeout_seconds, check=True,
                )
                if output.stat().st_size > limits.max_wav_bytes:
                    raise SpeechFailure(FailureCode.OUTPUT_LIMIT)
                with wave.open(str(output), "rb") as audio:
                    frames, rate = audio.getnframes(), audio.getframerate()
                    if frames <= 0 or rate <= 0:
                        raise SpeechFailure(FailureCode.FAILED)
                    if frames / rate > limits.max_duration_seconds:
                        raise SpeechFailure(FailureCode.OUTPUT_LIMIT)
                    expected = frames * audio.getsampwidth() * audio.getnchannels()
                    if len(audio.readframes(frames)) != expected:
                        raise SpeechFailure(FailureCode.FAILED)
                return output.read_bytes()
        except subprocess.TimeoutExpired:
            raise SpeechFailure(FailureCode.TIMEOUT) from None
        except (OSError, subprocess.CalledProcessError, wave.Error, EOFError):
            raise SpeechFailure(FailureCode.FAILED) from None
