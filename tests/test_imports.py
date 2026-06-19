#!/usr/bin/env python3
"""Guard against the missing-import NameError class that the #25/#28/#29/#30 god-file
splits introduced (and that shipped undetected because the early e2e stall hid the code
paths): a name used (Load) at runtime but bound NOWHERE in its module — e.g. pipeline.py
calling pixelvec_config / resolve_capability_step without importing them, so EVERY pipeline
run 500'd. `ast.parse` / `node --check` do NOT catch these (the name is syntactically fine);
only executing the path does. This static check does, in ~1s and with no optional ML deps.

Method: for each module, take the union of every name BOUND in it — the module's real runtime
namespace `vars(module)` (which includes `from X import *` names and all top-level
defs/imports/assigns) ∪ builtins ∪ every function's locals/params ∪ except-handler names ∪
comprehension targets — then flag any bare Name(Load) that resolves to none of them. Names in
annotation positions are skipped (under `from __future__ import annotations` they're strings,
never evaluated), as are dunders. Attribute access (`mod.attr`) only reads `mod`, so it never
false-positives. A clean run prints OK; any hit exits non-zero with file:line and the name.

Run: python3 tests/test_imports.py        (also invoked by tests/test_smoke.py + CI)
"""
import os, sys, ast, builtins, glob, importlib, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
BUILTINS = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__package__", "__loader__", "__spec__"}


def _annotation_name_ids(tree):
    """Object ids of every Name node sitting inside an annotation (skipped: not evaluated
    under `from __future__ import annotations`, and a missing annotation name is not a
    runtime NameError)."""
    ids = set()
    roots = []
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            roots += [a.annotation for a in (n.args.args + n.args.kwonlyargs + n.args.posonlyargs) if a.annotation]
            if n.args.vararg and n.args.vararg.annotation: roots.append(n.args.vararg.annotation)
            if n.args.kwarg and n.args.kwarg.annotation: roots.append(n.args.kwarg.annotation)
            if n.returns: roots.append(n.returns)
        elif isinstance(n, ast.AnnAssign) and n.annotation:
            roots.append(n.annotation)
    for r in roots:
        for d in ast.walk(r):
            if isinstance(d, ast.Name):
                ids.add(id(d))
    return ids


def _bound_names(tree, runtime_ns):
    bound = set(runtime_ns) | BUILTINS
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            a = n.args
            for arg in a.args + a.kwonlyargs + a.posonlyargs:
                bound.add(arg.arg)
            if a.vararg: bound.add(a.vararg.arg)
            if a.kwarg: bound.add(a.kwarg.arg)
            if not isinstance(n, ast.Lambda): bound.add(n.name)
        elif isinstance(n, ast.ClassDef):
            bound.add(n.name)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for al in n.names:
                bound.add(al.asname or al.name.split(".")[0])
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            bound.add(n.id)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)
    return bound


def check_module(modname, path):
    runtime_ns = vars(importlib.import_module(modname))
    src = open(path).read()
    tree = ast.parse(src, path)
    bound = _bound_names(tree, runtime_ns)
    anno = _annotation_name_ids(tree)
    hits = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and id(n) not in anno:
            if n.id not in bound and not n.id.startswith("__"):
                hits.append((n.id, n.lineno))
    return hits


def main():
    import server  # noqa: F401 — sets up sys.path (tools/) so hvserver submodules import
    import hvserver
    total = 0
    mods = [("hvserver." + m.name, os.path.join(ROOT, "hvserver", m.name + ".py"))
            for m in __import__("pkgutil").iter_modules(hvserver.__path__)]
    mods += [("server", os.path.join(ROOT, "server.py")), ("engine", os.path.join(ROOT, "engine.py"))]
    for modname, path in mods:
        for name, ln in check_module(modname, path):
            print(f"  [UNDEFINED] {os.path.relpath(path, ROOT)}:{ln}  '{name}' used but bound nowhere in the module")
            total += 1
    if total:
        print(f"FAIL: {total} undefined bare name(s) — a missing import after a module split?")
        return 1
    print(f"ok: no undefined module-global names across {len(mods)} server modules")
    return 0


if __name__ == "__main__":
    sys.exit(main())
