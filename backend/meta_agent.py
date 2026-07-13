"""
Meta-agent — reads episode traces, proposes a code diff to the task agent.

Loop 3 in the InfraBrain learning hierarchy:
  1. Collect N episode traces (telemetry window, suggestion, SRE decision, outcome)
  2. Cluster failures to find the dominant miss pattern
  3. Propose a diff to the task-agent retrieval/prompt code
  4. Caller evaluates the variant on held-out scenarios; accepts only if it improves

Powered by Gemini (same GEMINI_API_KEY as the task agent).
"""
import os
import json
from google import genai
from google.genai import types

MODEL = "gemini-2.0-flash"     # use gemini-2.5-pro for richer code-diff proposals

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set")
        _client = genai.Client(api_key=key)
    return _client


CURRENT_GEN_CODE = {
    0: """\
def retrieve_kg(symptom_sig: str, kg) -> list:
    # gen-0: exact label match only
    # MISS: near-miss signatures (same fault type, different node) are skipped
    hits = kg.query(label=symptom_sig)
    return hits

def build_prompt(window, hits) -> str:
    prompt  = f"Telemetry: {window.summary()}"
    if hits:
        prompt += f"\\nKG entries: {fmt(hits)}"
    return prompt
""",
    4: """\
def retrieve_kg(symptom_sig: str, kg) -> list:
    # gen-4: similarity retrieval; corrections ranked above seeds
    hits = kg.query_similar(symptom_sig, k=5)
    hits.sort(key=lambda h: (h.kind != "correction", h.age))
    return hits

def build_prompt(window, hits) -> str:
    prompt  = f"Telemetry: {window.summary()}"
    prompt += f"\\nKG corrections: {fmt(hits)}"
    prompt += "\\nIf a correction contradicts your hypothesis, explain why before deciding."
    return prompt
""",
}


async def run(traces: list[dict], current_gen: int) -> dict:
    """
    Propose a diff for the next agent generation.

    Returns:
      {
        "diff":                 str   — unified diff
        "explanation":          str   — what failed and why this fixes it
        "projectedImprovement": float — expected held-out composite delta
        "newGen":               int   — proposed generation number
      }
    """
    if not traces:
        return {
            "diff": "# No traces yet — run more episodes first.",
            "explanation": "Insufficient data for meta-agent analysis.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }

    overrides  = [t for t in traces if t.get("outcome") == "override"]
    total      = len(traces)

    if not overrides:
        return {
            "diff": f"# gen-{current_gen} performing well — zero overrides in last {total} episodes.",
            "explanation": "No misdiagnoses to fix.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }

    # Summarise failure pattern
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

    prompt = f"""You are the InfraBrain META-AGENT. Improve the task agent's diagnostic code
based on a batch of episode traces.

CURRENT GENERATION: gen-{current_gen}
CURRENT CODE:
```python
{current_code}
```

EPISODE BATCH SUMMARY:
  Total episodes:    {total}
  Override count:    {len(overrides)} ({override_rate:.0%})
  Dominant fault:    {dominant_fault} — misdiagnosed {fault_counts[dominant_fault]}×
  Most common wrong: {dominant_wrong}

SAMPLE OVERRIDE TRACES (last 5):
{json.dumps(overrides[-5:], indent=2)}

Propose a SPECIFIC code change that fixes the dominant miss pattern.
Focus on: retrieval strategy, evidence ranking, or prompt instructions.

Return ONLY a JSON object — no markdown fences:
{{
  "diff": "<unified diff with --- and +++ headers>",
  "explanation": "<2-3 sentences: what failed and why this change fixes it>",
  "projectedImprovement": <float: expected held-out composite improvement, e.g. 0.06>
}}"""

    try:
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
        return {
            "diff": f"# Meta-agent error: {exc}",
            "explanation": "Gemini call failed. Check GEMINI_API_KEY.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }
