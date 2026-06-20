"""Jobs layer (#29 split): the async job table + queue workers, the UI-liveness /
auto-spindown watchdog, the in-flight counter for heavy synchronous compute, and
`run_subprocess` (which registers its child with the current job so cancel can reach
it). Also the two leaf utils run_subprocess/_new_job_record depend on (shell_join,
now_id).

Sits ABOVE files in the import graph (it calls invalidate_outputs_cache +
the scratch pruners) but BELOW everything that launches work: models, engines, and
the pipeline import run_subprocess / launch_job / _report_progress / _register_output
from here. server.py re-exports it behind the façade so every server.X reference
(plus the do_GET/do_POST handler's job + heartbeat + in-flight calls) keeps resolving.

All reassigned module globals here (_inflight, _last_beat, _client_seen, _id_counter,
the threading.local _current_job) are underscore-private and only ever touched by this
module's own functions, so the façade's `import *` never binds a stale copy of them.
"""
from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
from pathlib import Path

from hvserver.paths import APP_DIR, OUTPUTS_DIR
from hvserver.files import (
    invalidate_outputs_cache, _prune_focused_pipeline_dirs, _prune_scratch_inline,
)


# ---- id / shell utils ------------------------------------------------------
_id_counter = 0
_id_lock = threading.Lock()


def now_id(prefix: str) -> str:
    global _id_counter
    with _id_lock:
        _id_counter += 1
        n = _id_counter
    return f"{prefix}-{int(time.time() * 1000)}-{n:04d}"


def shell_join(parts: list[str]) -> str:
    return subprocess.list2cmdline(parts)


# ---- job table -------------------------------------------------------------
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
# Per-job non-serializable state (subprocess handle, retry factory, cancel flag).
# Kept separate so jobs dict stays JSON-safe.
job_internals: dict[str, dict] = {}

JOB_CONCURRENCY = max(1, int(os.environ.get("HECTOR_CONCURRENCY", "1")))
job_queue: "queue.Queue[tuple[str, object]]" = queue.Queue()
TERMINAL_JOB_STATES = {"done", "failed", "cancelled"}
_workers_started = threading.Event()


# ---- UI liveness / auto-spindown -------------------------------------------
# The server is the program's compute half; the browser window is its face. When
# the window closes, nothing should be left running — a lingering old server gets
# reused by the next launch and then mismatches freshly-served client code, which
# is the whole "stale server → 404 storm → dead UI" class of bug. So the client
# pings /api/heartbeat on a timer, every request refreshes the same clock, and a
# watchdog shuts the process down once the UI has been silent past the grace
# window AND no job is in flight. Set HV_IDLE_SHUTDOWN=0 to disable (CI/headless,
# or a deliberately long-lived server).
IDLE_SHUTDOWN_SEC = float(os.environ.get("HV_IDLE_SHUTDOWN", "90"))
_last_beat = time.monotonic()
_beat_lock = threading.Lock()
_client_seen = False


def _touch_heartbeat() -> None:
    """Mark the UI as alive right now. Called on every request + the explicit ping."""
    global _last_beat, _client_seen
    with _beat_lock:
        _last_beat = time.monotonic()
        _client_seen = True


def _has_active_jobs() -> bool:
    with jobs_lock:
        return any(j.get("status") not in TERMINAL_JOB_STATES for j in jobs.values())


# Heavy synchronous compute endpoints (cleanup/restore/raster-op/trace-preview) run in
# the request thread with NO job record — so _has_active_jobs() can't see them. Without
# this counter, closing the window mid-operation (e.g. while rembg downloads its ~928MB
# weight) would let the watchdog shut the process down and truncate the in-flight write.
_inflight = 0
_inflight_lock = threading.Lock()
# POST paths whose handler does heavy synchronous compute (and registers no job).
HEAVY_SYNC_PATHS = {"/api/cleanup", "/api/face-restore", "/api/restore",
                    "/api/trace-preview", "/api/raster-op",
                    "/api/fonts/load", "/api/text-outline"}


def _inflight_incr() -> None:
    global _inflight
    with _inflight_lock:
        _inflight += 1


def _inflight_decr() -> None:
    global _inflight
    with _inflight_lock:
        _inflight -= 1


def _has_inflight() -> bool:
    with _inflight_lock:
        return _inflight > 0


def _idle_watchdog(server) -> None:
    """Exit when the UI is gone: silent past the grace window AND nothing running.
    Only arms after a client has connected at least once, so a server started a
    beat ahead of its browser (launch.sh) never quits during boot."""
    if IDLE_SHUTDOWN_SEC <= 0:
        return  # disabled
    while True:
        time.sleep(5)
        with _beat_lock:
            seen, idle = _client_seen, time.monotonic() - _last_beat
        if not seen or idle < IDLE_SHUTDOWN_SEC or _has_active_jobs() or _has_inflight():
            continue
        print(f"hector-vector: UI gone for {idle:.0f}s — spinning the server down.", flush=True)
        _gc_outputs()                 # tidy scratch on the way out
        server.shutdown()             # unblocks serve_forever() in main → clean exit
        return


def _gc_outputs() -> None:
    """Housekeeping sweep: bound the recovery-scratch dirs so they don't accumulate
    across sessions. Conservative by construction — the underlying pruners never
    touch a PNG-backed dir (it may back a live canvas href) or recent deliverables."""
    try:
        _prune_focused_pipeline_dirs()
        _prune_scratch_inline()
    except Exception:
        pass  # hygiene must never crash boot/shutdown


def _cancel_requested(job_id: str) -> bool:
    return bool(job_internals.get(job_id, {}).get("cancel_requested"))


def _set_internal(job_id: str, **kwargs) -> None:
    with jobs_lock:
        job_internals.setdefault(job_id, {}).update(kwargs)


# Thread-local current-job binding so run_subprocess can register its
# Popen handle with the right job for cancel.
_current_job = threading.local()


def _set_current_job(job_id: str | None) -> None:
    _current_job.job_id = job_id


def _current_job_id() -> str | None:
    return getattr(_current_job, "job_id", None)


def _report_progress(step: int, total: int, label: str | None = None) -> None:
    job_id = _current_job_id()
    if not job_id:
        return
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return
        job["progress"] = {"step": step, "total": total, "label": label}


def _register_output(path: Path) -> None:
    job_id = _current_job_id()
    if not job_id:
        return
    try:
        rel = path.relative_to(OUTPUTS_DIR).as_posix()
    except ValueError:
        rel = str(path)
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return
        outs = job.setdefault("outputs", [])
        if rel not in outs:
            outs.append(rel)
    invalidate_outputs_cache()


def _reap_job_proc(job_id: str) -> None:
    """Terminate a job's child process if it's still alive (called when the job
    body dies unexpectedly, so we never orphan a Popen / leak a zombie)."""
    with jobs_lock:
        proc = job_internals.get(job_id, {}).get("proc")
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:  # noqa: BLE001
        pass


def _run_guarded(job_id: str, fn) -> None:
    """Run a job body so it ALWAYS lands in a terminal state and never orphans its
    subprocess — even if fn() raises something other than the errors it handles
    itself. A thread dying with the job still "running" pins _has_active_jobs() true
    forever, which permanently disables auto-spindown (the stale-server class of bug)."""
    _set_current_job(job_id)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        with jobs_lock:
            job = jobs.get(job_id)
            if job is not None:
                job["log_lines"].append(f"job error: {exc.__class__.__name__}: {exc}")
                job["log_lines"] = job["log_lines"][-60:]
                if job["status"] not in TERMINAL_JOB_STATES:
                    job["status"] = "cancelled" if _cancel_requested(job_id) else "failed"
                    if job.get("returncode") is None:
                        job["returncode"] = 1
        _reap_job_proc(job_id)
    finally:
        # Backstop: if fn() returned without marking the job terminal, force it —
        # a stray early return must not leave the job hanging in "running".
        with jobs_lock:
            job = jobs.get(job_id)
            if job is not None and job["status"] not in TERMINAL_JOB_STATES:
                job["log_lines"].append("job ended without a terminal status; marking failed")
                job["status"] = "failed"
                if job.get("returncode") is None:
                    job["returncode"] = 1
        _set_current_job(None)
        invalidate_outputs_cache()


def _queue_worker() -> None:
    while True:
        job_id, runner = job_queue.get()
        try:
            with jobs_lock:
                job = jobs.get(job_id)
                if job is None:
                    continue
                if job["status"] != "queued":
                    continue
                if _cancel_requested(job_id):
                    job["status"] = "cancelled"
                    job["returncode"] = -1
                    job["started_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    continue
                job["status"] = "running"
                job["started_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            _run_guarded(job_id, runner)
        finally:
            job_queue.task_done()


def start_workers() -> None:
    if _workers_started.is_set():
        return
    _workers_started.set()
    for _ in range(JOB_CONCURRENCY):
        threading.Thread(target=_queue_worker, daemon=True).start()


# ---- subprocess plumbing (current-job aware) -------------------------------
def clean_log_line(line: str) -> str | None:
    noisy = [
        "queueC=",
        "queueG=",
        "queueT=",
        "bugsbn1=",
        "bugbilz=",
        "bugcopc=",
        "bugihfa=",
        "fp16-p/s/a=",
        "int8-p/s/a=",
        "subgroup=",
        "basic=",
        "vote=",
        "ballot=",
        "shuffle=",
    ]
    if any(token in line for token in noisy):
        return None
    line = line.rstrip()
    if not line:
        return None
    return line


def log_subprocess_lines(log, lines: list[str]) -> None:
    for line in lines:
        cleaned = clean_log_line(line)
        if cleaned:
            log(cleaned)


def run_subprocess(command: list[str], cwd: Path | None = None) -> list[str]:
    job_id = _current_job_id()
    proc = subprocess.Popen(
        command,
        cwd=str(cwd or APP_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    if job_id:
        _set_internal(job_id, proc=proc)
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        with proc.stdout:
            for line in proc.stdout:
                lines.append(line.rstrip())
        proc.wait()
    finally:
        if job_id:
            _set_internal(job_id, proc=None)
    if proc.returncode != 0:
        if job_id and _cancel_requested(job_id):
            raise RuntimeError("cancelled")
        tail = " | ".join(line for line in lines[-8:] if line)
        raise RuntimeError(tail or shell_join(command))
    return lines


# ---- launch / cancel / retry -----------------------------------------------
def _new_job_record(kind: str, summary: str | None, source_name: str | None, output_dir: str | None, *, queued: bool) -> str:
    job_id = now_id(kind)
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "kind": kind,
            "status": "queued" if queued else "running",
            "summary": summary or kind,
            "source_name": source_name,
            "output_dir": output_dir,
            "queued_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "started_at": None if queued else time.strftime("%Y-%m-%d %H:%M:%S"),
            "returncode": None,
            "log_lines": [],
            "outputs": [],
            "progress": None,
        }
    return job_id


def launch_job(
    kind: str,
    command: list[str],
    cwd: Path | None = None,
    summary: str | None = None,
    source_name: str | None = None,
    output_dir: str | None = None,
    immediate: bool = False,
    expected_outputs: list[Path] | None = None,
) -> dict:
    job_id = _new_job_record(kind, summary, source_name, output_dir, queued=not immediate)

    def retry_spec() -> dict:
        return launch_job(
            kind, command, cwd=cwd, summary=summary,
            source_name=source_name, output_dir=output_dir, immediate=immediate,
            expected_outputs=expected_outputs,
        )

    _set_internal(job_id, retry=retry_spec, retryable=True)

    def runner() -> None:
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(cwd or APP_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",   # cargo/curl can emit non-UTF-8; strict decode would crash the runner thread
                bufsize=1,
            )
        except FileNotFoundError as exc:
            with jobs_lock:
                jobs[job_id]["log_lines"].append(str(exc))
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["returncode"] = 127
            return
        _set_internal(job_id, proc=proc)
        with proc.stdout:
            for line in proc.stdout:
                cleaned = clean_log_line(line)
                if cleaned is None:
                    continue
                with jobs_lock:
                    jobs[job_id]["log_lines"].append(cleaned)
                    jobs[job_id]["log_lines"] = jobs[job_id]["log_lines"][-40:]
        proc.wait()
        with jobs_lock:
            jobs[job_id]["returncode"] = proc.returncode
            if _cancel_requested(job_id):
                jobs[job_id]["status"] = "cancelled"
            else:
                jobs[job_id]["status"] = "done" if proc.returncode == 0 else "failed"
        if proc.returncode == 0 and expected_outputs:
            for out_path in expected_outputs:
                if out_path.exists():
                    _register_output(out_path)

    if immediate:
        threading.Thread(target=lambda: _run_guarded(job_id, runner), daemon=True).start()
    else:
        start_workers()
        job_queue.put((job_id, runner))
    return jobs[job_id]


def launch_internal_job(
    kind: str,
    summary: str,
    worker,
    immediate: bool = False,
    source_name: str | None = None,
    output_dir: str | None = None,
) -> dict:
    job_id = _new_job_record(kind, summary, source_name, output_dir, queued=not immediate)

    def retry_spec() -> dict:
        return launch_internal_job(
            kind, summary, worker, immediate=immediate,
            source_name=source_name, output_dir=output_dir,
        )

    _set_internal(job_id, retry=retry_spec, retryable=True, internal=True)

    def log(line: str) -> None:
        cleaned = clean_log_line(line) or line.strip()
        if not cleaned:
            return
        with jobs_lock:
            jobs[job_id]["log_lines"].append(cleaned)
            jobs[job_id]["log_lines"] = jobs[job_id]["log_lines"][-60:]

    def runner() -> None:
        try:
            worker(log)
            with jobs_lock:
                jobs[job_id]["returncode"] = 0
                if _cancel_requested(job_id):
                    jobs[job_id]["status"] = "cancelled"
                else:
                    jobs[job_id]["status"] = "done"
        except Exception as exc:  # noqa: BLE001
            log(str(exc))
            with jobs_lock:
                jobs[job_id]["returncode"] = 1
                jobs[job_id]["status"] = "cancelled" if _cancel_requested(job_id) else "failed"

    if immediate:
        threading.Thread(target=lambda: _run_guarded(job_id, runner), daemon=True).start()
    else:
        start_workers()
        job_queue.put((job_id, runner))
    return jobs[job_id]


def cancel_job(payload: dict) -> dict:
    job_id = (payload.get("id") or "").strip()
    if not job_id:
        raise ValueError("Missing job id.")
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise ValueError(f"Unknown job {job_id}.")
        if job["status"] in TERMINAL_JOB_STATES:
            return {"message": f"Job already {job['status']}.", "id": job_id}
        job_internals.setdefault(job_id, {})["cancel_requested"] = True
        status = job["status"]
        proc = job_internals.get(job_id, {}).get("proc")
        internal = bool(job_internals.get(job_id, {}).get("internal"))
        if status == "queued":
            job["status"] = "cancelled"
            job["returncode"] = -1
            job["log_lines"].append("cancelled before start")
            return {"message": "Job cancelled.", "id": job_id}
    # status == "running"
    if proc is not None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception as exc:  # noqa: BLE001
            with jobs_lock:
                jobs[job_id]["log_lines"].append(f"cancel error: {exc}")
        with jobs_lock:
            jobs[job_id]["log_lines"].append("cancel signal sent to active subprocess")
        return {"message": "Cancel signal sent.", "id": job_id}
    if internal:
        # No active child process right now; the worker will stop at the
        # next subprocess call (or run to completion if it has none left).
        with jobs_lock:
            jobs[job_id]["log_lines"].append("cancel requested; will stop at next step")
        return {"message": "Cancel requested; will stop at next step.", "id": job_id}
    return {"message": "Cancel requested.", "id": job_id}


def retry_job(payload: dict) -> dict:
    job_id = (payload.get("id") or "").strip()
    if not job_id:
        raise ValueError("Missing job id.")
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise ValueError(f"Unknown job {job_id}.")
        retry = job_internals.get(job_id, {}).get("retry")
        if not retry:
            raise ValueError("Job cannot be retried.")
        if job["status"] not in TERMINAL_JOB_STATES:
            raise ValueError(f"Job is {job['status']}; only finished jobs can be retried.")
    new_job = retry()
    return {"message": "Job re-queued.", "id": new_job["id"]}


def has_running_job(kind: str) -> bool:
    with jobs_lock:
        return any(job["kind"] == kind and job["status"] == "running" for job in jobs.values())


def clear_finished_jobs() -> dict:
    with jobs_lock:
        done = [job_id for job_id, job in jobs.items() if job["status"] in TERMINAL_JOB_STATES]
        for job_id in done:
            jobs.pop(job_id, None)
            job_internals.pop(job_id, None)
    return {"message": f"Cleared {len(done)} finished job(s)."}
