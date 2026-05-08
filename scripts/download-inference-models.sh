#!/usr/bin/env bash
#
# Populates the assets.opendaw.studio staging folder with inference ONNX
# models, ready for upload to the production CDN.
#
# Output layout:
#   assets.opendaw.studio/models/<task>/<version>/model.onnx
#
# The lib (`@opendaw/lib-inference`) and the studio runtime fetch from
# https://assets.opendaw.studio/... so once these files have been
# uploaded, the studio works without any further configuration.
#
# The local staging folder is gitignored. Re-run this script after a
# fresh checkout, or whenever a task bumps its model version. SHA-256
# digests printed at the end should match the corresponding
# TaskDefinition.model.sha256 in packages/lib/inference/src/tasks/.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_DIR="${REPO_ROOT}/assets.opendaw.studio/models"

mkdir -p "${STAGING_DIR}"

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
# License: MIT (facebookresearch/demucs); ONNX export by smank/htdemucs-onnx.
# ---------------------------------------------------------------------------
HTDEMUCS_DEST="${STAGING_DIR}/htdemucs/v4/model.onnx"
HTDEMUCS_URL="${HTDEMUCS_URL:-https://huggingface.co/smank/htdemucs-onnx/resolve/469b019bf7ac20e03dc68a8fa791323434862390/htdemucs.onnx}"

# ---------------------------------------------------------------------------
# Stem separation alt: htdemucs v4 (jackjiangxinfa/demucs-onnx)
# License: Apache-2.0. Same architecture, different export. Useful for A/B.
# ---------------------------------------------------------------------------
HTDEMUCS_JX_DEST="${STAGING_DIR}/htdemucs-jx/v4/model.onnx"
HTDEMUCS_JX_URL="${HTDEMUCS_JX_URL:-https://huggingface.co/jackjiangxinfa/demucs-onnx/resolve/49fcb820b3fa39937e955dda5cef1ad35dec1f7c/model.onnx}"

# ---------------------------------------------------------------------------
# Audio-to-MIDI: Spotify Basic Pitch (polyphonic transcription)
# License: Apache-2.0 (spotify/basic-pitch); ONNX via AEmotionStudio.
# ---------------------------------------------------------------------------
BASIC_PITCH_DEST="${STAGING_DIR}/basic-pitch/v0.4.0/model.onnx"
BASIC_PITCH_URL="${BASIC_PITCH_URL:-https://huggingface.co/AEmotionStudio/basic-pitch-onnx-models/resolve/327fd8ccd2f0bb84cbe56b4a0e9d318398ddf763/nmp.onnx}"

echo "Staging models into ${STAGING_DIR} for upload to assets.opendaw.studio"
echo

download_if_missing "${HTDEMUCS_URL}" "${HTDEMUCS_DEST}" || echo "[warn] htdemucs download failed; set HTDEMUCS_URL and retry"
download_if_missing "${HTDEMUCS_JX_URL}" "${HTDEMUCS_JX_DEST}" || echo "[warn] htdemucs-jx download failed; set HTDEMUCS_JX_URL and retry"
download_if_missing "${BASIC_PITCH_URL}" "${BASIC_PITCH_DEST}" || echo "[warn] basic-pitch download failed; set BASIC_PITCH_URL and retry"

echo
echo "SHA-256 digests (cross-check against TaskDefinition.model.sha256):"
for file in "${HTDEMUCS_DEST}" "${HTDEMUCS_JX_DEST}" "${BASIC_PITCH_DEST}"; do
    if [[ -f "${file}" ]]; then
        printf "  %-60s %s\n" "${file#${REPO_ROOT}/}" "$(print_sha "${file}")"
    fi
done
echo
echo "Next step: upload the contents of assets.opendaw.studio/ to the CDN"
echo "preserving the relative paths. The runtime URLs are then live."
