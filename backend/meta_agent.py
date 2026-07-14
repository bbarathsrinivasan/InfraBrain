"""
Meta-agent — reads episode traces, proposes a code diff to the task agent.

Scripted fallback only when GEMINI_API_KEY is unset.
Set GEMINI_API_KEY in backend/.env for live Gemini diff proposals.
"""
import os
import json

MODEL = "gemini-flash-latest"

_client = None

SCRIPTED_DIFF = """--- agents/gen3/diagnose.py
+++ agents/gen4/diagnose.py
@@ meta agent · gen-4 · held-out 0.55 → 0.61

-    # Exact label match only
-    hits = kg.query(label=symptom.label)
+    # Gen-3 traces: 6/9 misses were near-miss sigs.
+    # Similarity retrieval; rank corrections first.
+    hits = kg.query_similar(symptom.signature, k=5)
+    hits.sort(key=lambda h:(h.kind!="correction",h.age))

-    prompt += f"Telemetry: {window.summary()}"
+    prompt += f"Telemetry: {window.summary()}"
+    prompt += f"\\nKG corrections: {fmt(hits)}"
+    prompt += "\\nIf a correction contradicts your"
+    prompt += " hypothesis, explain why before deciding."""


def use_scripted() -> bool:
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key or key.endswith("..."):
        return True
    flag = os.environ.get("USE_SCRIPTED_AGENT", "").lower()
    return flag in ("1", "true", "yes")


def _get_client():
    global _client
    if _client is None:
        from google import genai
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set")
        _client = genai.Client(api_key=key)
    return _client


CURRENT_GEN_CODE = {
    0: """\
def retrieve_kg(symptom_sig: str, kg) -> list:
    hits = kg.query(label=symptom_sig)
    return hits
""",
    4: """\
def retrieve_kg(symptom_sig: str, kg) -> list:
    hits = kg.query_similar(symptom_sig, k=5)
    hits.sort(key=lambda h: (h.kind != "correction", h.age))
    return hits
""",
}


def run_scripted(traces: list[dict], current_gen: int) -> dict:
    """Deterministic meta-agent output from trace statistics."""
    if not traces:
        return {
            "diff": "# No traces yet — run more episodes first.",
            "explanation": "Insufficient data for meta-agent analysis.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }

    overrides = [t for t in traces if t.get("outcome") == "override"]
    total     = len(traces)

    if not overrides:
        return {
            "diff": f"# gen-{current_gen} performing well — zero overrides in last {total} episodes.",
            "explanation": "No misdiagnoses to fix.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }

    fault_counts: dict[str, int] = {}
    for t in overrides:
        ft = t.get("faultType", "unknown")
        fault_counts[ft] = fault_counts.get(ft, 0) + 1
    dominant = max(fault_counts, key=fault_counts.get)
    rate = len(overrides) / total

    return {
        "diff": SCRIPTED_DIFF,
        "explanation": (
            f"{len(overrides)}/{total} episodes ({rate:.0%}) required override. "
            f"Dominant miss: {dominant} faults misread as CPU overload. "
            "Switching to similarity retrieval with corrections ranked first fixes near-miss signatures."
        ),
        "projectedImprovement": round(min(0.08, 0.04 + rate * 0.06), 2),
        "newGen": current_gen + 1,
    }


async def run(traces: list[dict], current_gen: int) -> dict:
    if use_scripted():
        return run_scripted(traces, current_gen)

    if not traces:
        return run_scripted(traces, current_gen)

    overrides  = [t for t in traces if t.get("outcome") == "override"]
    total      = len(traces)
    if not overrides:
        return run_scripted(traces, current_gen)

    fault_counts:  dict[str, int] = {}
    wrong_actions: dict[str, int] = {}
    for t in overrides:
        ft = t.get("faultType", "unknown")
        wa = t.get("suggested",  "unknown")
        fault_counts[ft]   = fault_counts.get(ft, 0) + 1
        wrong_actions[wa]  = wrong_actions.get(wa, 0) + 1

    dominant_fault = max(fault_counts,  key=fault_counts.get)
    dominant_wrong = max(wrong_actions, key=wrong_actions.get)
    override_rate  = len(overrides) / total
    current_code   = CURRENT_GEN_CODE.get(current_gen, CURRENT_GEN_CODE[0])

    prompt = f"""You are the InfraBrain META-AGENT. Propose a code change based on traces.

CURRENT GENERATION: gen-{current_gen}
CURRENT CODE:
```python
{current_code}
```

EPISODE BATCH: {total} episodes, {len(overrides)} overrides ({override_rate:.0%})
Dominant fault: {dominant_fault} · most common wrong action: {dominant_wrong}

SAMPLE OVERRIDES:
{json.dumps(overrides[-5:], indent=2)}

Return ONLY JSON:
{{"diff": "...", "explanation": "...", "projectedImprovement": 0.06}}"""

    try:
        from google.genai import types
        client = _get_client()
        response = await client.aio.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=800,
                temperature=0.3,
            ),
        )
        result = json.loads(response.text)
        result["newGen"] = current_gen + 1
        return result
    except Exception as exc:
        out = run_scripted(traces, current_gen)
        out["explanation"] = f"Gemini unavailable ({exc}). Using scripted diff."
        return out
