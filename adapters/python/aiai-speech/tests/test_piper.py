# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave

from aiai_speech import FailureCode, Piper, SpeechFailure, SpeechLimits


class PiperTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        executable = root / "piper"
        executable.touch()
        self.model = root / "voice.onnx"
        self.model.touch()
        Path(str(self.model) + ".json").write_text("{}")
        self.engine = Piper(executable)
        self.limits = SpeechLimits(3, 2, 32000)

    def write_audio(self, command, **kwargs):
        self.output = Path(command[-1])
        with wave.open(str(self.output), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\0" * 1600)
        self.assertEqual(kwargs["input"], "Привіт".encode())
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(kwargs["timeout"], 3)

    @patch("aiai_speech.subprocess.run")
    def test_audio_and_cleanup(self, run):
        run.side_effect = self.write_audio
        result = self.engine.synthesize("Привіт", self.model, self.limits)
        self.assertEqual(result[:4], b"RIFF")
        self.assertFalse(self.output.parent.exists())

    @patch("aiai_speech.subprocess.run")
    def test_size_refusal_and_cleanup(self, run):
        run.side_effect = self.write_audio
        with self.assertRaises(SpeechFailure) as error:
            self.engine.synthesize("Привіт", self.model, SpeechLimits(3, 2, 100))
        self.assertEqual(error.exception.code, FailureCode.OUTPUT_LIMIT)
        self.assertFalse(self.output.parent.exists())

    @patch("aiai_speech.subprocess.run")
    def test_timeout(self, run):
        run.side_effect = subprocess.TimeoutExpired("private", 3)
        with self.assertRaises(SpeechFailure) as error:
            self.engine.synthesize("Привіт", self.model, self.limits)
        self.assertEqual(str(error.exception), "timeout")

    @patch("aiai_speech.subprocess.run")
    def test_invalid_text_never_runs(self, run):
        for text in ("", "[[phonemes]]", "\x00", "\ud800"):
            with self.assertRaises(SpeechFailure) as error:
                self.engine.synthesize(text, self.model, self.limits)
            self.assertEqual(error.exception.code, FailureCode.INVALID_INPUT)
        run.assert_not_called()

    @patch("aiai_speech.subprocess.run")
    def test_missing_model_never_runs(self, run):
        with self.assertRaises(SpeechFailure) as error:
            self.engine.synthesize("Привіт", self.model.with_name("missing"), self.limits)
        self.assertEqual(error.exception.code, FailureCode.UNAVAILABLE)
        run.assert_not_called()

    @patch("aiai_speech.subprocess.run")
    def test_duration_limit(self, run):
        run.side_effect = self.write_audio
        with self.assertRaises(SpeechFailure) as error:
            self.engine.synthesize("Привіт", self.model, SpeechLimits(3, 0.01, 32000))
        self.assertEqual(error.exception.code, FailureCode.OUTPUT_LIMIT)
