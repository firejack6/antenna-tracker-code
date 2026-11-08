"""Create companion flight files with a 5s telemetry gap starting just before peak accel.

Keeps originals intact so normal tracking still works.
"""
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAP_S = 5.0
LEAD_S = 0.5  # start gap this many seconds before peak accel


def write_home(src_name: str, dst_name: str, note: str, gap_label: str = "5s gap") -> None:
    src = HERE / f"{src_name}.home.json"
    dst = HERE / f"{dst_name}.home.json"
    if not src.is_file():
        return
    data = json.loads(src.read_text(encoding="utf-8"))
    data["notes"] = (data.get("notes") or "") + (" " if data.get("notes") else "") + note
    base = str(data.get("label") or Path(src_name).stem)
    # Strip prior gap suffixes before appending the current one.
    for junk in (" · 5s gap", " · 10s gap"):
        base = base.replace(junk, "")
    data["label"] = f"{base} · {gap_label}"
    dst.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("wrote", dst.name)


def gap_altus() -> None:
    src_name = "2024-05-19-serial-11226-flight-0001.csv"
    dst_name = "2024-05-19-serial-11226-flight-0001-gap5s.csv"
    src = HERE / src_name
    text = src.read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    header_i = next(i for i, ln in enumerate(lines) if "latitude" in ln.lower() and "acceleration" in ln.lower())
    header = lines[header_i]
    # DictReader needs clean fieldnames; keep raw lines for output fidelity
    reader = csv.DictReader(lines[header_i:])
    rows = list(reader)
    field = {k.strip().lower(): k for k in (reader.fieldnames or []) if k}
    accel_key = field["acceleration"]
    time_key = field["time"]

    peak_t = None
    peak_a = None
    for row in rows:
        try:
            t = float(row[time_key])
            a = float(row[accel_key])
        except (TypeError, ValueError):
            continue
        if peak_a is None or a > peak_a:
            peak_a, peak_t = a, t
    assert peak_t is not None
    t0 = peak_t - LEAD_S
    t1 = t0 + GAP_S
    print(f"Altus peak accel {peak_a:.2f} at t={peak_t:.3f}s → gap [{t0:.3f}, {t1:.3f})")

    kept_body = []
    dropped = 0
    for line in lines[header_i + 1 :]:
        if not line.strip():
            continue
        # Parse time as first numeric after version fields: time is column index 4
        parts = [p.strip() for p in line.split(",")]
        try:
            t = float(parts[4])
        except (IndexError, ValueError):
            kept_body.append(line)
            continue
        if t0 <= t < t1:
            dropped += 1
            continue
        kept_body.append(line)

    out_lines = lines[: header_i] + [header] + kept_body
    (HERE / dst_name).write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(f"wrote {dst_name}: dropped {dropped} rows, kept {len(kept_body)}")
    write_home(
        src_name,
        dst_name,
        f"Synthetic 5s TARGET gap [{t0:.2f},{t1:.2f}) just before peak accel {peak_a:.0f} at t={peak_t:.2f}s.",
    )


def gap_openrocket(src_name: str, window_s: float = 60.0, gap_s: float = GAP_S, tag: str | None = None) -> None:
    stem = Path(src_name).stem
    gap_s = float(gap_s)
    tag = tag or (f"gap{int(gap_s)}s" if abs(gap_s - int(gap_s)) < 1e-6 else f"gap{gap_s:g}s".replace(".", "p"))
    dst_name = f"{stem}-{tag}.csv"
    src = HERE / src_name
    lines = src.read_text(encoding="utf-8").splitlines()
    pts = []
    for i, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = [p.strip() for p in s.split(",")]
        if len(parts) < 4:
            continue
        try:
            t, alt, lat, lon = map(float, parts[:4])
        except ValueError:
            continue
        pts.append((i, t, alt))

    # Vertical velocity then accel; ignore landing spikes by limiting to ascent window.
    vs = []
    for j in range(1, len(pts)):
        _, t0, a0 = pts[j - 1]
        _, t, alt = pts[j]
        dt = t - t0
        if dt <= 0:
            continue
        vs.append((t, (alt - a0) / dt, alt))
    max_alt_t = max(pts, key=lambda p: p[2])[1]
    ascent_end = min(window_s, max_alt_t) if window_s else max_alt_t
    acc = []
    for j in range(1, len(vs)):
        t0, v0, _ = vs[j - 1]
        t, v, alt = vs[j]
        dt = t - t0
        if dt <= 0 or t > ascent_end:
            continue
        acc.append((t, (v - v0) / dt, alt))
    peak_t, peak_a, _ = max(acc, key=lambda x: x[1])
    g0 = peak_t - LEAD_S
    g1 = g0 + gap_s
    print(f"{src_name} peak vert accel {peak_a:.1f} at t={peak_t:.3f}s → gap [{g0:.3f}, {g1:.3f})")

    out = []
    dropped = 0
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#"):
            out.append(line)
            continue
        parts = [p.strip() for p in s.split(",")]
        if len(parts) < 4:
            out.append(line)
            continue
        try:
            t = float(parts[0])
        except ValueError:
            out.append(line)
            continue
        if g0 <= t < g1:
            dropped += 1
            continue
        out.append(line)

    (HERE / dst_name).write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {dst_name}: dropped {dropped} rows")
    write_home(
        src_name,
        dst_name,
        f"Synthetic {gap_s:g}s TARGET gap [{g0:.2f},{g1:.2f}) just before peak accel at t={peak_t:.2f}s.",
        gap_label=f"{gap_s:g}s gap",
    )


if __name__ == "__main__":
    gap_altus()
    gap_openrocket("testdata1.csv", window_s=60.0, gap_s=5.0)
    gap_openrocket("copper45.csv", window_s=130.0, gap_s=10.0)  # long burn; 10s dropout before peak
