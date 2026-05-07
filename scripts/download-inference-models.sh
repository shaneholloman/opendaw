#!/usr/bin/env bash
#
# Optional: caches inference ONNX models locally for offline development.
# The studio fetches directly from upstream Hugging Face at runtime and
# does not require these files to be on disk. Run this only if you want
# to inspect the models manually or work offline.
#
# Output layout:
#   packages/app/studio/public/models/<task>/<version>/model.onnx
#
# Local copies are gitignored. Cross-check the printed SHA-256 against
# the task definitions in packages/lib/inference/src/tasks/ if you
# suspect upstream drift.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${REPO_ROOT}/packages/app/studio/public/models"

mkdir -p "${MODELS_DIR}"

download_if_missing() {
    local url="$1"
    local dest="$2"
    if [[ -f "${dest}" ]]; then
        echo "[skip] ${dest} already exists"
        return 0
    fi
    mkdir -p "$(dirname "${dest}")"
    echo "[fetch] ${url}"
    curl -fL --progress-bar -o "${dest}.partial" "${url}"
    mv "${dest}.partial" "${dest}"
    echo "[done] ${dest}"
}

print_sha() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${file}" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "${file}" | awk '{print $1}'
    else
        echo "(no sha256 tool found)"
    fi
}

# ---------------------------------------------------------------------------
# Stem separation: htdemucs v4 (Demucs Hybrid Transformer, 4-stem split)
# License: MIT (facebookresearch/demucs)
# ---------------------------------------------------------------------------
HTDEMUCS_DEST="${MODELS_DIR}/htdemucs/v4/model.onnx"
HTDEMUCS_URL="${HTDEMUCS_URL:-https://huggingface.co/ModernMube/HTDemucs_onnx/resolve/edd8347a8191d6b73635675688d01e125d3ae336/htdemucs.onnx}"

# ---------------------------------------------------------------------------
# Pitch estimation: CREPE tiny (monophonic pitch contour)
# License: MIT (marl/crepe)
# ---------------------------------------------------------------------------
# CREPE: no canonical ONNX export available at the time of writing.
# Skipping for v1; export from marl/crepe yourself or wait for an upstream
# ONNX release if pitch estimation is needed.

# ---------------------------------------------------------------------------
# Audio-to-MIDI: Spotify Basic Pitch (polyphonic transcription)
# License: Apache-2.0 (spotify/basic-pitch)
# ---------------------------------------------------------------------------
BASIC_PITCH_DEST="${MODELS_DIR}/basic-pitch/v0.4.0/model.onnx"
BASIC_PITCH_URL="${BASIC_PITCH_URL:-https://huggingface.co/AEmotionStudio/basic-pitch-onnx-models/resolve/327fd8ccd2f0bb84cbe56b4a0e9d318398ddf763/nmp.onnx}"

echo "Downloading models into ${MODELS_DIR}"
echo

download_if_missing "${HTDEMUCS_URL}" "${HTDEMUCS_DEST}" || echo "[warn] htdemucs download failed; set HTDEMUCS_URL and retry"
download_if_missing "${BASIC_PITCH_URL}" "${BASIC_PITCH_DEST}" || echo "[warn] basic-pitch download failed; set BASIC_PITCH_URL and retry"

echo
echo "SHA-256 digests (cross-check against TaskDefinition.model.sha256):"
for file in "${HTDEMUCS_DEST}" "${BASIC_PITCH_DEST}"; do
    if [[ -f "${file}" ]]; then
        printf "  %-60s %s\n" "${file#${REPO_ROOT}/}" "$(print_sha "${file}")"
    fi
done
