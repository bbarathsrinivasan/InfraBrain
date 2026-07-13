"""
Meta-agent — reads episode traces, proposes a code diff to the task agent.

Loop 3 in the InfraBrain learning hierarchy:
  1. Collect N episode traces (telemetry window, suggestion, SRE decision, outcome)
  2. Cluster failures to find the dominant miss pattern
  3. Propose a diff to agents/genN/diagnose.py (retrieval, ranking, or prompt)
  4. Caller evaluates the variant on held-out scenarios; accepts only if it improves

This is an LLM-powered code-rewriting call — the meta-agent reads the traces and
produces the exact diff shown in the Learning Lab tab.
"""
import os
import json
import anthropic

MODEL = "claude-sonnet-4-5"

_client: anthropic.AsyncAnthropic | None = None


def _get_client():
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        _client = anthropic.AsyncAnthropic(api_key=key)
    return _client


CURRENT_GEN_CODE = {
    0: """\
def retrieve_kg(symptom_sig: str, kg) -> list:
    # gen-0: exact label match only
    # MISS: near-miss signatures (e.g. same fault, different node) are skipped
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
    # gen-4: similarity retrieval; corrections ranked first
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

    overrides = [t for t in traces if t.get("outcome") == "override"]
    total     = len(traces)

    if not overrides:
        return {
            "diff": f"# gen-{current_gen} performing well — zero overrides in last {total} episodes.",
            "explanation": "No misdiagnoses to fix.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }

    # Summarise failure pattern
    fault_counts: dict[str, int] = {}
    wrong_actions: dict[str, int] = {}
    for t in overrides:
        ft = t.get("faultType", "unknown")
        wa = t.get("suggested", "unknown")
        fault_counts[ft]    = fault_counts.get(ft, 0) + 1
        wrong_actions[wa]   = wrong_actions.get(wa, 0) + 1

    dominant_fault  = max(fault_counts,  key=fault_counts.get)
    dominant_wrong  = max(wrong_actions, key=wrong_actions.get)
    override_rate   = len(overrides) / total

    current_code = CURRENT_GEN_CODE.get(current_gen, CURRENT_GEN_CODE[0])

    prompt = f"""You are the InfraBrain META-AGENT. Your job is to improve the task agent's
diagnostic code based on a batch of episode traces.

CURRENT GENERATION: gen-{current_gen}
CURRENT CODE:
```python
{current_code}
```

EPISODE BATCH SUMMARY:
  Total episodes:     {total}
  Override count:     {len(overrides)} ({override_rate:.0%})
  Dominant fault:     {dominant_fault} (misdiagnosed {fault_counts[dominant_fault]}×)
  Most common wrong:  {dominant_wrong}

SAMPLE OVERRIDE TRACES (last 5):
{json.dumps(overrides[-5:], indent=2)}

Your task: propose a SPECIFIC code change that would fix the dominant miss pattern.
Focus on: retrieval strategy, evidence ranking, or prompt instructions.

Respond with ONLY valid JSON:
{{
  "diff": "<unified diff — include --- and +++ header lines>",
  "explanation": "<2-3 sentences: what failed, why this specific change fixes it>",
  "projectedImprovement": <float: expected held-out composite improvement, e.g. 0.06>
}}"""

    try:
        client = _get_client()
        msg = await client.messages.create(
            model=MODEL,
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        if "```" in raw:
            raw = raw.split("```")[1].lstrip("json").strip()
            raw = raw.split("```")[0].strip()

        result = json.loads(raw)
        result["newGen"] = current_gen + 1
        return result

    except Exception as exc:
        return {
            "diff": f"# Meta-agent error: {exc}",
            "explanation": "LLM call failed. Check ANTHROPIC_API_KEY.",
            "projectedImprovement": 0.0,
            "newGen": current_gen,
        }
