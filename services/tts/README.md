# TTS host adapter

An independent HTTP host adapter, not part of the inference core. Proposed public route: https://api.aiaiaiai.org/tts/v1/speech (not deployed). POST /v1/speech accepts JSON with exactly text and voice; returns Ogg/Opus bytes, never a download URL. GET /healthz checks process startup. Request text is not logged, persisted, sent to a provider, or associated with a person identifier. The temporary synthesis files are removed after each request.

Authorization: AIS EdDSA product access token (typ at+jwt), issuer https://auth.aiaiaiai.org, audience tts, scope tts.synthesize. No shared key. The grant and public route require separate AIS/infra changes and validation; no production access is assumed. Configure TTS_AIS_JWKS_URL with the verified issuer JWKS endpoint. TTS_MODELS is a JSON map of voice aliases to administrator-installed absolute ONNX paths (e.g. uk-UA). Each voice must have its adjacent .onnx.json configuration. Install and verify Piper CLI and FFmpeg with libopus separately; neither engine nor model weights are vendored or distributed by this adapter. Audit the engine and each model's license, provenance and checksums before provisioning.

From this directory, install requirements into a virtual environment, then run:

    gunicorn --workers 1 --threads 4 --timeout 120 --bind 0.0.0.0:8080 'server:create_app()'

Keep one worker per instance; the engine is limited to one in-flight request. Reverse proxy must enforce HTTPS, request body limit 48000 bytes, bounded connections and per-product ingress quotas; disable body capture and use redacted request telemetry. Maximum text 10000 characters and audio 300 seconds / 10 MiB; requests over limits fail rather than truncate. No output is cached. Readiness requires local engine, model and config files; real speech synthesis, model performance, resource limits, product grants and ingress still need deployment smoke tests. Do not expose this service publicly before those checks. The adapter's own Apache-2.0 license does not cover external engine or model artifacts.

Unit tests: python -m unittest discover -s services/tts -p 'test_*.py' from repository root.
