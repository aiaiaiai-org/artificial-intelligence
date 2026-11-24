# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

"""Bounded, product-authorized speech synthesis host adapter."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit
import wave

import jwt

ISSUER = "https://auth.aiaiaiai.org"
AUDIENCE = "tts"
SCOPE = "tts.synthesize"
MAX_BODY = 48_000
MAX_TEXT = 10_000
MAX_AUDIO = 10 * 1024 * 1024
MAX_SECONDS = 300


class Rejected(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class ProductAuthorization:
    def __init__(self, jwks_url):
        parsed = urlsplit(jwks_url)
        if (parsed.scheme, parsed.netloc) != ("https", "auth.aiaiaiai.org"):
            raise ValueError("AIS JWKS must use the pinned HTTPS issuer")
        self.keys = jwt.PyJWKClient(jwks_url, timeout=3, lifespan=300)

    def __call__(self, header):
        if not header.startswith("Bearer ") or len(header) > 8192:
            raise Rejected("401 Unauthorized", "invalid_token")
        token = header[7:]
        try:
            metadata = jwt.get_unverified_header(token)
            if metadata.get("typ") != "at+jwt" or metadata.get("alg") != "EdDSA":
                raise jwt.InvalidTokenError()
            key = self.keys.get_signing_key_from_jwt(token)
            claims = jwt.decode(token, key.key, algorithms=["EdDSA"],
                                issuer=ISSUER, audience=AUDIENCE,
                                options={"require": ["iss", "aud", "sub", "iat", "exp"]})
            if type(claims["iat"]) is not int or type(claims["exp"]) is not int:
                raise jwt.InvalidTokenError()
            if not 0 < claims["exp"] - claims["iat"] <= 300:
                raise jwt.InvalidTokenError()
        except jwt.PyJWKClientConnectionError:
            raise Rejected("503 Service Unavailable", "issuer_unavailable") from None
        except jwt.PyJWTError:
            raise Rejected("401 Unauthorized", "invalid_token") from None
        scope = claims.get("scope")
        if not isinstance(scope, str) or SCOPE not in scope.split():
            raise Rejected("403 Forbidden", "insufficient_scope")


class LocalSpeech:
    """External executable boundary; no provider network calls."""
    def __init__(self, models):
        self.models = {name: Path(path).resolve() for name, path in models.items()}
        self.piper = shutil.which("piper")
        self.ffmpeg = shutil.which("ffmpeg")
        if not self.piper or not self.ffmpeg or not self.models:
            raise RuntimeError("speech engine or voices not configured")
        for path in self.models.values():
            if not path.is_file() or not Path(str(path) + ".json").is_file():
                raise RuntimeError("voice model or config missing")

    def __call__(self, text, voice):
        if voice not in self.models:
            raise Rejected("422 Unprocessable Entity", "unknown_voice")
        with tempfile.TemporaryDirectory(prefix="tts-") as directory:
            wav = Path(directory) / "speech.wav"
            ogg = Path(directory) / "speech.ogg"
            try:
                subprocess.run([self.piper, "-m", str(self.models[voice]), "-f", str(wav)],
                               input=text.encode("utf-8"), stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=75, check=True)
                with wave.open(str(wav), "rb") as audio:
                    if audio.getnframes() / audio.getframerate() > MAX_SECONDS:
                        raise Rejected("422 Unprocessable Entity", "audio_too_long")
                subprocess.run([self.ffmpeg, "-nostdin", "-v", "error", "-i", str(wav),
                                "-c:a", "libopus", "-b:a", "32k", "-ac", "1",
                                "-f", "ogg", str(ogg)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=15, check=True)
                if ogg.stat().st_size > MAX_AUDIO:
                    raise Rejected("422 Unprocessable Entity", "audio_too_large")
                result = ogg.read_bytes()
                if not result.startswith(b"OggS") or b"OpusHead" not in result[:256]:
                    raise RuntimeError("invalid audio")
                return result
            except subprocess.TimeoutExpired:
                raise Rejected("504 Gateway Timeout", "synthesis_timeout") from None
            except (OSError, subprocess.CalledProcessError, wave.Error, EOFError, RuntimeError):
                raise Rejected("502 Bad Gateway", "synthesis_failed") from None


def app_factory(authorize, synthesize):
    # Deployment must use one worker; threads share the bounded engine slot.
    slot = threading.BoundedSemaphore(1)

    def app(env, start):
        def reply(status, data, content_type="application/json"):
            start(status, [("Content-Type", content_type), ("Content-Length", str(len(data))),
                           ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")])
            return [data]

        try:
            path = env.get("PATH_INFO")
            method = env.get("REQUEST_METHOD")
            if path == "/healthz" and method == "GET":
                return reply("200 OK", b'{"status":"ok"}')
            if path != "/v1/speech":
                raise Rejected("404 Not Found", "not_found")
            if method != "POST":
                raise Rejected("405 Method Not Allowed", "method_not_allowed")
            authorize(env.get("HTTP_AUTHORIZATION", ""))
            if env.get("CONTENT_TYPE", "").split(";")[0].strip().lower() != "application/json":
                raise Rejected("415 Unsupported Media Type", "invalid_content_type")
            try:
                size = int(env.get("CONTENT_LENGTH", ""))
            except ValueError:
                raise Rejected("411 Length Required", "length_required") from None
            if size < 1 or size > MAX_BODY:
                raise Rejected("413 Payload Too Large", "invalid_size")
            try:
                raw = env["wsgi.input"].read(size)
                if len(raw) != size:
                    raise ValueError()
                payload = json.loads(raw.decode("utf-8"))
                if not isinstance(payload, dict) or set(payload) != {"text", "voice"}:
                    raise ValueError()
                text, voice = payload["text"], payload["voice"]
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                    raise ValueError()
                if not isinstance(voice, str) or not 1 <= len(voice) <= 64:
                    raise ValueError()
                text.encode("utf-8")
                if "\x00" in text or "[[" in text:
                    raise ValueError()
            except (ValueError, UnicodeError, RecursionError):
                raise Rejected("422 Unprocessable Entity", "invalid_request") from None
            if not slot.acquire(blocking=False):
                raise Rejected("429 Too Many Requests", "engine_busy")
            try:
                audio = synthesize(text, voice)
            finally:
                slot.release()
            return reply("200 OK", audio, "audio/ogg")
        except Rejected as exc:
            return reply(exc.status, json.dumps({"error": exc.code}).encode())
        except Exception:
            # Do not log request payloads, subprocess output, or exception values.
            return reply("500 Internal Server Error", b'{"error":"internal_error"}')
    return app


def create_app():
    models = json.loads(os.environ["TTS_MODELS"])
    if not isinstance(models, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                               for k, v in models.items()):
        raise ValueError("invalid voice map")
    return app_factory(ProductAuthorization(os.environ["TTS_AIS_JWKS_URL"]),
                       LocalSpeech(models))
