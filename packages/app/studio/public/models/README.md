# Inference models

The `@opendaw/lib-inference` task definitions reference ONNX models by
**commit-pinned upstream URLs** (Hugging Face). Models are fetched
directly from the upstream repository at runtime, verified against a
SHA-256 baked into the task definition, and cached in OPFS so the
download happens exactly once per user per model version.

**openDAW does not self-host the model binaries.** This folder exists
only to document attribution and provide an optional offline-dev cache;
the runtime path does not depend on it.

## Why direct upstream fetch

- Hugging Face is Cloudflare-backed CDN infrastructure designed for
  exactly this access pattern (`resolve/<commit-sha>/<file>`). Reliable
  uptime, COEP-compatible CORS headers, 1-year cache TTL.
- No bandwidth bill, no upload step, no Git LFS, no storage on
  `assets.opendaw.studio`.
- SHA-256 verification on download means corruption / repo tampering
  fails loudly rather than silently.
- Commit-pinned URLs are immutable: even if the upstream uploader
  replaces the file in their repo, the pinned URL keeps serving the
  original bytes (HF retains commit history indefinitely for non-orphaned
  branches).

The remaining residual risk is the upstream repo being deleted entirely.
SHA verification keeps already-cached users working; new users would see
the download fail until openDAW publishes a task update with a fresh
URL. If this becomes a real-world problem, mirroring on the openDAW CDN
is a one-config-line change in the task definition.

## Current models

### htdemucs / v4 — stem separation

- **Upstream**: [`ModernMube/HTDemucs_onnx`](https://huggingface.co/ModernMube/HTDemucs_onnx)
- **File**: `htdemucs.onnx`
- **Pinned commit**: `edd8347a8191d6b73635675688d01e125d3ae336`
- **Original model**: [facebookresearch/demucs](https://github.com/facebookresearch/demucs) v4 hybrid transformer
- **License**: MIT
- **Size**: 174,490,597 bytes
- **SHA-256**: `ac056d976fbcf300dbc9e5ae6c1e7c8e7eb9a0ee9000e0449d993e3edef797d6`

### basic-pitch / v0.4.0 — audio-to-MIDI transcription

- **Upstream**: [`AEmotionStudio/basic-pitch-onnx-models`](https://huggingface.co/AEmotionStudio/basic-pitch-onnx-models)
- **File**: `nmp.onnx`
- **Pinned commit**: `327fd8ccd2f0bb84cbe56b4a0e9d318398ddf763`
- **Original model**: [spotify/basic-pitch](https://github.com/spotify/basic-pitch) (ICASSP 2022)
- **License**: Apache-2.0
- **Size**: 230,444 bytes
- **SHA-256**: `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec`

## Optional: cache locally for offline dev

If you want the models on disk for offline work, run the script that
sits next to this README:

```bash
./packages/app/studio/public/models/download.sh
# or, equivalently, the convenience wrapper at the repo root:
./scripts/download-inference-models.sh
```

Both populate `packages/app/studio/public/models/<task>/<version>/model.onnx`
from the same upstream URLs. The studio still fetches via the absolute
upstream URL at runtime; the local copy is just for inspection / manual
testing. The downloaded `.onnx` files are gitignored so a stray binary
cannot land in the repo.

The colocated `download.sh` is the canonical recipe; the top-level
wrapper at `scripts/download-inference-models.sh` is a convenience entry
point. If the wrapper is ever deleted, the colocated copy still works
(it is path-relative to its own directory).

## Adding a new task

1. Find or upload an ONNX export on a Hugging Face repo with a permissive
   license.
2. Note the **commit SHA** that contains the file:
   `https://huggingface.co/api/models/<owner>/<repo>/commits/main`.
3. Compute the file's SHA-256:
   `curl -L <url> | shasum -a 256`.
4. Create a task file under
   `packages/lib/inference/src/tasks/` using `defineTask` and pin the URL
   (commit SHA, not `main`), byte count, and SHA-256.
5. Register the task in `packages/lib/inference/src/registry.ts`.
6. Optionally add the URL to `scripts/download-inference-models.sh` so
   other devs can populate the offline cache.
