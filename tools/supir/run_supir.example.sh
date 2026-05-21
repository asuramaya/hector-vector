#!/usr/bin/env bash
set -euo pipefail

INPUT_PATH="${1:?input path required}"
OUTPUT_DIR="${2:?output dir required}"

echo "SUPIR wrapper placeholder"
echo "Input: $INPUT_PATH"
echo "Output dir: $OUTPUT_DIR"
echo
echo "Copy this file to run_supir.sh and replace it with your actual SUPIR command."
echo "Example shape:"
echo "python gradio_demo.py --some-flags ..."
