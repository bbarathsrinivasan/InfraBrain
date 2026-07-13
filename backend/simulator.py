"""
Fault-injection simulator — authoritative Python port of the in-browser stepNodes().
Produces the same thermal/utilization/memory dynamics; deterministic modulo random seed.
"""
import random
import math

# ── Fault schedule ────────────────────────────────────────────────────────
FAULTS = [
    {"node": "R2-N5", "type": "fan", "start": 10},
    {"node": "R3-N2", "type": "mem", "start": 22},
]
FAULT_NODE = "R2-N5"   # hero scenario for gen-0 vs gen-4 comparison


def fresh_nodes() -> list[dict]:
    nodes = []
    for r in range(1, 5):
        for n in range(1, 9):
            nodes.append({
                "id":     f"R{r}-N{n}",
                "temp":   round(56 + random.random() * 10, 1),
                "util":   round(52 + random.random() * 28, 1),
                "fan":    round(55 + random.random() * 12, 1),
                "mem":    round(34 + random.random() * 16, 1),
                "job":    f"job-{1000 + r * 8 + n}(trace)",
                "status": "ok",
            })
    return nodes


def _status(temp: float) -> str:
    if temp >= 88: return "crit"
    if temp >= 75: return "warn"
    return "ok"


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def fault_for(node_id: str):
    return next((f for f in FAULTS if f["node"] == node_id), None)


def step_nodes(nodes: list[dict], t: int, repairs: list[dict]) -> list[dict]:
    """Advance the simulation one tick. repairs is the current repair queue."""
    result = []
    for nd in nodes:
        temp, util, fan, mem = nd["temp"], nd["util"], nd["fan"], nd["mem"]

        fault = fault_for(nd["id"])
        # Find an applied repair for this node
        rep = next(
            (r for r in repairs if r["node"] == nd["id"] and r["effectApplied"]),
            None
        )

        # Random jitter
        util = _clamp(util + (random.random() - 0.49) * 4, 20, 98)
        mem  = _clamp(mem  + (random.random() - 0.50) * 1.5, 20, 99)

        # Fault dynamics (applied if fault started and no repair yet)
        if fault and t >= fault["start"] and not rep:
            if fault["type"] == "fan":
                fan = max(14, fan - 3.0)
            if fault["type"] == "mem":
                mem = min(99, mem + 2.4)

        # Repair effects
        if rep:
            a = rep["action"]
            if   a == "ramp_fans":        fan  = min(96, fan  + 9)
            elif a == "throttle_job":     util = max(25, util - 12)
            elif a == "migrate_workload": util = max(20, util - 18); mem = max(25, mem - 14)
            elif a == "drain_node":       util = max(5,  util - 22)
            elif a == "restart_node":     mem  = max(24, mem  - 16)

        # Thermal throttling — the deceptive symptom
        if temp >= 88:
            util *= 0.93

        # Memory pressure adds heat
        mem_heat = (mem - 82) * 0.12 if mem > 82 else 0

        # Heat equation
        dT = 0.085 * util - 0.082 * fan - 0.45 + mem_heat + (random.random() - 0.5) * 0.7
        temp = _clamp(temp + dT, 45, 104)

        result.append({
            "id":     nd["id"],
            "temp":   round(temp, 1),
            "util":   round(util, 1),
            "fan":    round(fan,  1),
            "mem":    round(mem,  1),
            "job":    nd["job"],
            "status": _status(temp),
        })
    return result
