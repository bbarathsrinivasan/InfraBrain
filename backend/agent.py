"""
Task agent — LLM-powered diagnosis with KG-augmented prompts.

Two retrieval modes (mirrors the meta-agent evolution):
  gen-0  : exact-label lookup (high miss rate on near-miss signatures)
  gen-4+ : similarity-ranked retrieval, corrections ranked first

askAgent() is the SRE-console chat handler — streaming.
diagnose() is the incident-diagnosis call — structured JSON output.

To wire a different model or provider: change MODEL and the client init.
"""
import os
import json
import anthropic
from kg import retrieve_similar

MODEL = "claude-sonnet-4-5"          # swap to claude-opus-4-5 for richer reasoning

_client: anthropic.AsyncAnthropic | None = None

def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not set — add it to backend/.env")
        _client = anthropic.AsyncAnthropic(api_key=key)
    return _client


# ── Diagnosis ─────────────────────────────────────────────────────────────

def _build_diagnose_prompt(node: dict, window: list[dict], gen: int, hits: list[dict]) -> str:
    recent = window[-12:] if len(window) >= 12 else window
    if len(recent) >= 3:
        dt = recent[-1]["temp"] - recent[-3]["temp"]
        df = recent[-1]["fan"]  - recent[-3]["fan"]
        dm = recent[-1]["mem"]  - recent[-3]["mem"]
        du = recent[-1]["util"] - recent[-3]["util"]
    else:
        dt = df = dm = du = 0.0

    kg_block = ""
    if hits:
        kg_block = "\n\nKG CORRECTIONS (similarity-ranked, corrections first):\n"
        for h in hits:
            c = h["correction"]
            kg_block += (f"  sim={h['sim']:.2f}  sig={c['signature']}  "
                         f"rejected={c['rejected']} → applied={c['applied']}  ctx={c['context']}\n")

    gen_hint = (
        "You have access to KG corrections — if a correction contradicts your hypothesis, "
        "you MUST explain why before deciding."
        if gen >= 4 else
        "Use your base knowledge only."
    )

    return f"""You are InfraBrain Task Agent (gen-{gen}), diagnosing a GPU datacenter node.

NODE: {node['id']}
CURRENT:  temp={node['temp']}°C  util={node['util']}%  fan={node['fan']}%  mem={node['mem']}%
TRENDS (Δ over 3 ticks):  temp{dt:+.1f}°C  fan{df:+.1f}%  util{du:+.1f}%  mem{dm:+.1f}%
JOB: {node['job']}
{kg_block}
AVAILABLE ACTIONS: ramp_fans | throttle_job | migrate_workload | drain_node | restart_node | escalate | no_action

CRITICAL DIAGNOSTIC NOTE:
  Fan failure signature: fan↓ sustained + temp↑ while util is FALLING (thermal throttling).
  CPU-overload signature: util↑ sustained + temp↑ with fan STABLE or rising.
  Memory-leak signature:  mem↑ monotonic + temp rising + util flat.
  These look similar at first glance — the fan/mem trends are the discriminating signal.

{gen_hint}

Respond with ONLY valid JSON — no markdown, no explanation outside the JSON:
{{
  "diagnosis": "<concise root-cause, ≤12 words>",
  "action":    "<one action from the list above>",
  "conf":      <float 0.0–1.0>,
  "evidence":  ["<observation 1>", "<observation 2>", "<observation 3>"]
}}"""


async def diagnose(node: dict, window: list[dict], gen: int) -> dict:
    """
    Call the LLM to diagnose a node.
    Returns a suggestion dict: {diagnosis, action, conf, evidence}
    Falls back to scripted response on any error.
    """
    # Build signature string for KG retrieval
    fan_declining = (node["fan"] < 50)
    mem_high      = (node["mem"] > 78)
    if fan_declining:
        sig = f"temp↑/fan↓ @ {node['id']}"
    elif mem_high:
        sig = f"temp↑/mem↑ @ {node['id']}"
    else:
        sig = f"temp↑/util↑ @ {node['id']}"

    # Retrieval — gen-0 exact only (misses near-miss sigs), gen-4 similarity
    all_hits = retrieve_similar(sig, k=5)
    hits = [h for h in all_hits if h["sim"] > 0.8] if gen < 4 else all_hits

    prompt = _build_diagnose_prompt(node, window, gen, hits)

    try:
        client = _get_client()
        msg = await client.messages.create(
            model=MODEL,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        # Strip accidental markdown fences
        if "```" in raw:
            raw = raw.split("```")[1].lstrip("json").strip()
            raw = raw.split("```")[0].strip()

        result = json.loads(raw)

        # Append KG evidence if similarity-ranked corrections were used
        if hits and gen >= 4:
            top = hits[0]
            result.setdefault("evidence", []).append(
                f"KG correction (sim={top['sim']}): {top['correction']['signature']} — "
                f"rejected {top['correction']['rejected']}, applied {top['correction']['applied']}"
            )
        return result

    except Exception as exc:
        return _fallback(node, gen, str(exc))


def _fallback(node: dict, gen: int, reason: str = "") -> dict:
    """Scripted fallback — identical to the in-browser buildSuggestion()."""
    fan_low  = node.get("fan", 60) < 45
    mem_high = node.get("mem", 40) > 80
    note     = f" [LLM fallback: {reason[:60]}]" if reason else ""

    if gen >= 4:
        if fan_low:
            return {
                "diagnosis": "Fan degradation → thermal cascade",
                "action":    "ramp_fans",
                "conf":      0.91,
                "evidence":  [
                    f"fan {node['fan']:.0f}% — sustained decline (leading indicator)",
                    f"temp slope rising while util falling (thermal throttling, not load)",
                    f"KG correction: identical sig — throttle_job rejected, ramp_fans applied{note}",
                ],
            }
        if mem_high:
            return {
                "diagnosis": "Memory leak — heap climbing to OOM",
                "action":    "migrate_workload",
                "conf":      0.88,
                "evidence":  [
                    f"mem {node['mem']:.0f}% — monotonic rise, no GC recovery",
                    "temp rising with mem, util flat — not a compute burst",
                    f"KG correction: mem↑ sig — throttle_job rejected, migrate applied{note}",
                ],
            }

    return {
        "diagnosis": "CPU overload on training job",
        "action":    "throttle_job",
        "conf":      0.72,
        "evidence":  [
            f"util {node['util']:.0f}% sustained with rising temp",
            f"temp {node['temp']:.1f}°C — assuming compute-bound",
            f"KG seed: temp spike + util high → cpu overload (fan/mem signal not weighted){note}",
        ],
    }


# ── SRE console chat (streaming) ───────────────────────────────────────────

async def ask_agent_stream(text: str, context: dict):
    """
    Async generator that streams SRE-console replies token-by-token.

    context keys: focusNode, incident, node, corrections, gen

    ── HOW TO REPLACE WITH A DIFFERENT PROVIDER ──────────────────────────
    Replace the `async with client.messages.stream(...)` block with your
    provider's streaming call.  Yield each text token in the inner loop.
    The FastAPI SSE handler above doesn't care how the tokens arrive.
    """
    node_id     = context.get("focusNode", "unknown")
    incident    = context.get("incident")
    node        = context.get("node", {})
    corrections = context.get("corrections", [])
    gen         = context.get("gen", 0)

    # Build system context
    inc_ctx = ""
    if incident:
        inc_ctx = (f"\n\nACTIVE INCIDENT on {node_id}: stage={incident.get('stage')}, "
                   f"type={incident.get('faultType','unknown')}")
        sug = incident.get("suggestion")
        if sug:
            inc_ctx += f"\nCurrent suggestion: {sug.get('diagnosis')} → {sug.get('action')} (conf {sug.get('conf')})"

    kg_ctx = ""
    if corrections:
        last = corrections[-1]
        kg_ctx = (f"\n\nKG: {len(corrections)} correction(s). "
                  f"Most recent: rejected {last.get('rejected')} → applied {last.get('applied')}.")

    system = f"""You are InfraBrain (gen-{gen}), an AI SRE assistant for a GPU datacenter.

Focus node: {node_id}
State: temp={node.get('temp','?')}°C  util={node.get('util','?')}%  fan={node.get('fan','?')}%  mem={node.get('mem','?')}%{inc_ctx}{kg_ctx}

Rules:
- Be concise (≤4 sentences). Technical, grounded in current node state.
- For action commands (/ramp_fans, /migrate, etc.), confirm what was queued and the expected metric effect.
- For question commands (/explain, /history, /status), give a direct factual answer.
- If something is uncertain, say so — don't hallucinate telemetry.
"""

    try:
        client = _get_client()
        async with client.messages.stream(
            model=MODEL,
            max_tokens=300,
            system=system,
            messages=[{"role": "user", "content": text}],
        ) as stream:
            async for chunk in stream.text_stream:
                yield chunk
    except Exception as exc:
        yield f"[Agent error: {exc}. Check ANTHROPIC_API_KEY and model availability.]"
