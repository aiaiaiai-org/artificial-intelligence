# © 2026 aiaiaiai · aiaiaiai.org
# SPDX-License-Identifier: Apache-2.0

import io
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from server import app_factory, ProductAuthorization, Rejected, ISSUER, AUDIENCE, SCOPE


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.engine = Mock(return_value=b"OggSexample")
        self.key = Ed25519PrivateKey.generate()
        self.auth = ProductAuthorization(ISSUER + "/jwks")
        self.auth.keys = Mock()
        self.auth.keys.get_signing_key_from_jwt.return_value = SimpleNamespace(
            key=self.key.public_key())
        self.app = app_factory(self.auth, self.engine)

    def token(self, changes=None, typ="at+jwt", key=None):
        now = int(time.time())
        claims = dict(iss=ISSUER, aud=AUDIENCE, sub="product", scope=SCOPE,
                      iat=now, exp=now + 300)
        claims.update(changes or {})
        return jwt.encode(claims, key or self.key, algorithm="EdDSA",
                          headers={"typ": typ, "kid": "test"})

    def request(self, token=None, payload=None, path="/v1/speech", method="POST"):
        raw = json.dumps(payload if payload is not None else
                         {"text": "Привіт", "voice": "uk-UA"}).encode()
        start = Mock()
        response = self.app(dict(PATH_INFO=path, REQUEST_METHOD=method,
                                 CONTENT_TYPE="application/json",
                                 CONTENT_LENGTH=str(len(raw)),
                                 HTTP_AUTHORIZATION="Bearer " + token if token else "",
                                 **{"wsgi.input": io.BytesIO(raw)}), start)
        status, headers = start.call_args.args
        return status, dict(headers), b"".join(response)

    def test_authorized(self):
        status, headers, body = self.request(self.token())
        self.assertEqual(status, "200 OK")
        self.assertEqual(headers["Content-Type"], "audio/ogg")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(body, b"OggSexample")
        self.engine.assert_called_once_with("Привіт", "uk-UA")

    def test_missing_token(self):
        self.assertEqual(self.request()[0], "401 Unauthorized")
        self.engine.assert_not_called()

    def test_wrong_token(self):
        for token in (self.token({"aud": "another"}),
                      self.token({"iss": "https://other.example"}),
                      self.token(typ="id+jwt"),
                      self.token(key=Ed25519PrivateKey.generate()),
                      self.token({"iat": 1, "exp": 301}),
                      self.token({"exp": int(time.time()) + 600})):
            with self.subTest(token=token[:20]):
                self.assertEqual(self.request(token)[0], "401 Unauthorized")
        self.engine.assert_not_called()

    def test_missing_scope(self):
        self.assertEqual(self.request(self.token({"scope": "profile"}))[0], "403 Forbidden")
        self.engine.assert_not_called()

    def test_bounds_and_schema(self):
        for payload in ({"text": "x" * 10001, "voice": "uk-UA"},
                        {"text": " ", "voice": "uk-UA"},
                        {"text": "secret", "voice": "uk-UA", "chat_id": 1},
                        {"text": "[[raw]]", "voice": "uk-UA"}):
            self.assertEqual(self.request(self.token(), payload)[0], "422 Unprocessable Entity")
        self.engine.assert_not_called()

    def test_errors_do_not_leak(self):
        self.engine.side_effect = RuntimeError("private text")
        self.assertEqual(self.request(self.token())[2], b'{"error":"internal_error"}')

    def test_health(self):
        self.assertEqual(self.request(path="/healthz", method="GET")[0], "200 OK")
        self.engine.assert_not_called()

    def test_engine_error(self):
        self.engine.side_effect = Rejected("422 Unprocessable Entity", "unknown_voice")
        self.assertEqual(self.request(self.token())[0], "422 Unprocessable Entity")


if __name__ == "__main__":
    unittest.main()
