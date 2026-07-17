#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import io
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, ExifTags

from engine import build_alpha_cutout, build_monochrome_assets, has_meaningful_alpha


# Foundational layer (paths, constants, on-disk config, tool/model presence probes)
# lives in hvserver/paths.py (#29 split). It runs sys.path.insert(TOOLS_DIR) +
# mimetypes.add_type at import, so the tool imports below resolve. Re-exported here so
# `server.OUTPUTS_DIR` / `server.source_dir()` / `server.LAMA_MODEL` etc. keep working.
from hvserver.paths import *  # noqa: F401,F403
from hvserver.paths import (  # underscore helpers (not picked up by `import *`)
    _load_config, _save_config, _config_lock, _venv_has,
)

import pixelvec  # noqa: E402  (pure numpy/PIL, no venv needed)
import svg_render  # noqa: E402  (pure Pillow for axis-aligned SVGs; cairosvg optional)
import simplify_svg  # noqa: E402  (pure numpy; refit traced paths to minimal cubics)
import analyze  # noqa: E402  (pure numpy/PIL; the classical auto-routing brain — analyze→plan)

# Capabilities taxonomy + router resolution (hvserver/capabilities.py, #29 split).
# Re-exported so server.CAPABILITIES / resolve_capability_step / resolve_intent /
# capabilities_info keep resolving for the router + /api/capabilities + tests.
from hvserver.capabilities import *  # noqa: F401,F403,E402

# Files layer (hvserver/files.py, #29 split): work-items, the outputs/ library, uploads,
# rename/remove/info. Jobs-independent. Re-exported so server.list_outputs / select_inputs /
# save_uploaded_files / etc. keep resolving for run_pipeline, the job GC, and the HTTP handler.
from hvserver.files import *  # noqa: F401,F403,E402
from hvserver.files import (  # underscore helpers called from the regions that stayed here
    _safe_stem, _prune_focused_pipeline_dirs, _prune_scratch_inline, _read_body,
)

# Jobs layer (hvserver/jobs.py, #29 split): the async job table + queue workers, the
# UI-liveness auto-spindown watchdog, the heavy-sync in-flight counter, run_subprocess
# (current-job aware), and launch/cancel/retry. Models, engines, and the pipeline call
# run_subprocess / launch_job / _report_progress / _register_output from here, so it must
# be importable before them. Re-exported so server.jobs / launch_job / cancel_job / etc.
# (and the HTTP handler's heartbeat + in-flight + job endpoints) keep resolving.
from hvserver.jobs import *  # noqa: F401,F403,E402
from hvserver.jobs import (  # underscore helpers called from the regions that stayed here
    _touch_heartbeat, _inflight_incr, _inflight_decr, _idle_watchdog, _gc_outputs,
    _report_progress, _register_output,
)

# Models layer (hvserver/models.py, #29 split): tool/weight installers + bootstrap, the
# tool-readiness gate, atomic fetch_model, the per-capability model registries
# (AI_CUTOUT_MODELS / SR_MODELS / RESTORE_STAGE_MODELS), the build_* executors, and the
# transient cleanup/face/restore op endpoints. Engines + the pipeline call build_* /
# ensure_tools_ready / the registries from here. Re-exported so server.build_ai_cutout /
# SR_MODELS / cleanup_inpaint / etc. keep resolving (incl. _skip_message used by the pipeline).
from hvserver.models import *  # noqa: F401,F403,E402
from hvserver.models import _skip_message  # noqa: E402  (underscore; called from run_pipeline)

# Engines layer (hvserver/engines.py, #29 split): the vectorize / trace / raster-op core —
# trace+mask config, preprocessing, the vtracer bw/colour paths, the planar clean-colour
# tracer, pixelvec, raster ops, and the VECTORIZE_ENGINES / RASTER_OPS registries with their
# single dispatch entry points (vectorize_svg / apply_raster_op). The pipeline + HTTP handler
# call these from here. Re-exported so server.vectorize_svg / VECTORIZE_ENGINES / etc. resolve.
from hvserver.engines import *  # noqa: F401,F403,E402
from hvserver.engines import _trace_ceiling  # noqa: E402  (underscore; asserted by test_smoke)

# Pipeline layer (hvserver/pipeline.py, #29 split): multi-stage process orchestration + the
# analyze endpoints — stage parsing, suggest_trace_settings/plan_image (the classical brain's
# HTTP surface), trace_preview (live one-shot vectorize), and run_pipeline (batch/focused
# restore→upscale→cutout→vectorize executor). Top of the compute stack; only the HTTP handler
# sits above it. Re-exported so server.run_pipeline / plan_image / trace_preview / etc. resolve.
from hvserver.pipeline import *  # noqa: F401,F403,E402
from hvserver.pipeline import (  # underscore helpers asserted by test_smoke
    _stage_on, _pipeline_stages, _pipeline_summary,
)

# Documents layer (hvserver/documents.py, #29 split): document-persistence endpoints —
# save_render / save_svg / save_hv / list_projects / save_svg_as (+ _resolve_output_svg).
# Re-exported so the HTTP handler's save endpoints keep resolving.
from hvserver.documents import *  # noqa: F401,F403,E402

# System layer (hvserver/system.py, #29 split): non-compute endpoints — seed_inputs,
# tool_status, and the git-pull self-update surface (version_info/check_update/apply_update).
# Re-exported so the HTTP handler + main() keep reaching them.
from hvserver.system import *  # noqa: F401,F403,E402

# PDF export (hvserver/export_pdf.py, Epic O.1): SVG -> real vector PDF via cairosvg
# (an existing optional dependency). Re-exported so `server.export_pdf` resolves.
from hvserver.export_pdf import export_pdf  # noqa: F401,E402

# HTTP layer (hvserver/http.py, #29 split): the Handler request dispatcher + main() entry.
# Highest fan-out (it calls every endpoint), so it imports last. Re-exported so `server.Handler`
# / `server.main` resolve and `python server.py` (the `if __name__` guard below) still serves.
from hvserver.http import *  # noqa: F401,F403,E402


# (#29 ensure_dirs relocated -> hvserver/paths.py)


# (#29 system layer -> hvserver/system.py: seed_inputs)


# (#29 jobs utils -> hvserver/jobs.py: _id_counter + now_id + shell_join)




# (#29 command_exists relocated -> hvserver/paths.py)


# (#29 system layer -> hvserver/system.py: tool_status)


# (#29 files layer -> hvserver/files.py - region 1/3: path helpers + scratch/pipeline-dir pruning)


# (#29 engines layer -> hvserver/engines.py: validators + trace/mask config + preprocess + vtracer bw/colour paths)


# (#29 system layer -> hvserver/system.py: version_info / check_update / apply_update + _git helpers)


# (#29 models layer -> hvserver/models.py: tool-readiness + fetch_model + registries + build_* + AI-op endpoints)


# (#29 engines layer -> hvserver/engines.py: pixelvec_config + validate_pixelvec_svg)
# (#29 documents layer -> hvserver/documents.py: save_render/save_svg/save_hv/list_projects/save_svg_as + _resolve_output_svg)


# (#29 engines layer -> hvserver/engines.py: derive_mask_from_alpha)
# (#29 pipeline layer -> hvserver/pipeline.py: stage parsing + analyze endpoints + trace_preview + run_pipeline)


# (#29 files layer -> hvserver/files.py - region 3/3: uploads + rename/remove + work-item info + reveal)


# (#29 jobs layer -> hvserver/jobs.py: clear_finished_jobs)




# (#29 shlex_quote relocated -> hvserver/paths.py)


# (#29 http layer -> hvserver/http.py: Handler request dispatch + main() entry; re-exported via the facade import above)


if __name__ == "__main__":
    main()
