# aiai-speech

A Python host adapter for local Piper speech inference, separate from the deterministic Rust kernel. Install from this directory or consume a verified immutable Git revision with this subdirectory. No package registry publication is implied.

```python
from pathlib import Path
from aiai_speech import Piper, SpeechLimits

engine = Piper(Path("/opt/bin/piper"))
wav = engine.synthesize(
    "Hello", Path("/models/selected.onnx"), SpeechLimits(30, 60, 8_000_000)
)
```

The consumer supplies the executable, model and limits. The adapter runs the external executable with no shell, returns validated PCM WAV bytes, removes temporary files and reports closed failure codes. It does not own voice catalogs, language selection, authorization, API, queueing, audio delivery format, or deployment. It does not download executable or model artifacts. Verify model and engine provenance externally. The timeout bounds invocation time; the output size check bounds returned bytes, not transient disk usage. The caller must isolate and limit subprocess resources. Neither Piper nor its model artifacts are bundled or relicensed.

Tests use a fake process boundary and WAV fixture generation; actual model inference requires a separate model smoke test.

Apache-2.0; see LICENSE and NOTICE.
