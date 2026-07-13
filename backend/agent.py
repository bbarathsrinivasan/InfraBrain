"""
Task agent — Gemini-powered diagnosis with KG-augmented prompts.

Two retrieval modes (mirrors the meta-agent evolution):
  gen-0  : exact-label lookup (high miss rate on near-miss signatures)
  gen-4+ : similarity-ranked retrieval, corrections ranked first

ask_agent_stream() — SRE-console chat, streaming token-by-token via SSE.
diagnose()         — incident diagnosis, structured JSON output.

Model: gemini-2.0-flash (fast) — switch to gemini-2.5-flash/pro for richer reasoning.
"""
import os
import json
from google import genai
from google.genai import types
from kg import retrieve_similar

MODEL = "gemini-2.0-flash"       # gemini-2.5-flash · gemini-2.5-pro for stronger reasoning

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set — add it to backend/.env")
        _client = genai.Client(api_key=key)
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
        "You have access to KG corrections above — if any correction contradicts "
        "your hypothesis, you MUST explain why before deciding."
        if gen >= 4 else
        "Use base telemetry knowledge only — ignore any KG data."
    )

    return f"""You are InfraBrain Task Agent (gen-{gen}), diagnosing a GPU datacenter node.

NODE: {node['id']}
CURRENT:  temp={node['temp']}°C  util={node['util']}%  fan={node['fan']}%  mem={node['mem']}%
TRENDS (Δ over 3 ticks):  temp{dt:+.1f}°C  fan{df:+.1f}%  util{du:+.1f}%  mem{dm:+.1f}%
JOB: {node['job']}
{kg_block}
AVAILABLE ACTIONS: ramp_fans | throttle_job | migrate_workload | drain_node | restart_node | escalate | no_action

CRITICAL DIAGNOSTIC NOTE:
  Fan failure: fan↓ sustained + temp↑ while util FALLS (thermal throttling — deceptive!).
  CPU overload: util↑ sustained + temp↑, fan STABLE or rising.
  Memory leak:  mem↑ monotonic + temp rising + util flat.

{gen_hint}

Return ONLY a JSON object — no markdown fences, no extra text:
{{
  "diagnosis": "<root-cause, ≤12 words>",
  "action":    "<one action from the list>",
  "conf":      <float 0.0-1.0>,
  "evidence":  ["<observation 1>", "<observation 2>", "<observation 3>"]
}}"""


async def diagnose(node: dict, window: list[dict], gen: int) -> dict:
    """
    Call Gemini to diagnose a node.
    Returns {diagnosis, action, conf, evidence}. Falls back to scripted on error.
    """
    fan_declining = node["fan"] < 50
    mem_high      = node["mem"] > 78
    sig = (f"temp↑/fan↓ @ {node['id']}"  if fan_declining else
           f"temp↑/mem↑ @ {node['id']}"  if mem_high      else
           f"temp↑/util↑ @ {node['id']}")

    all_hits = retrieve_similar(sig, k=5)
    # gen-0: only surface near-identical matches (> 0.8); gen-4+: full similarity
    hits = [h for h in all_hits if h["sim"] > 0.8] if gen < 4 else all_hits

    prompt = _build_diagnose_prompt(node, window, gen, hits)

    try:
        client = _get_client()
        response = await client.aio.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",   # guaranteed JSON from Gemini
                max_output_tokens=512,
                temperature=0.2,
            ),
        )
        result = json.loads(response.text)

        # Append KG evidence note when corrections were retrieved
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
    """Scripted fallback — mirrors the in-browser buildSuggestion()."""
    fan_low  = node.get("fan", 60) < 45
    mem_high = node.get("mem", 40) > 80
    note     = f" [Gemini fallback: {reason[:60]}]" if reason else ""

    if gen >= 4:
        if fan_low:
            return {
                "diagnosis": "Fan degradation → thermal cascade",
                "action":    "ramp_fans",
                "conf":      0.91,
                "evidence":  [
                    f"fan {node['fan']:.0f}% — sustained decline (leading indicator)",
                    "temp rising while util falling — thermal throttling, not load",
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
    Async generator — streams SRE-console reply token-by-token via Gemini.

    context keys: focusNode, incident, node, corrections, gen

    ── HOW TO SWITCH MODEL ────────────────────────────────────────────────
    Change the MODULE-LEVEL `MODEL` constant above.
    gemini-2.0-flash   → fast, low latency (default)
    gemini-2.5-flash   → better reasoning, slightly slower
    gemini-2.5-pro     → best quality, for complex diagnoses
    """
    node_id     = context.get("focusNode", "unknown")
    incident    = context.get("incident")
    node        = context.get("node", {})
    corrections = context.get("corrections", [])
    gen         = context.get("gen", 0)

    inc_ctx = ""
    if incident:
        inc_ctx = (f"\n\nACTIVE INCIDENT on {node_id}: stage={incident.get('stage')}, "
                   f"type={incident.get('faultType','unknown')}")
        sug = incident.get("suggestion")
        if sug:
            inc_ctx += (f"\nCurrent diagnosis: {sug.get('diagnosis')} → "
                        f"{sug.get('action')} (conf {sug.get('conf')})")

    kg_ctx = ""
    if corrections:
        last = corrections[-1]
        kg_ctx = (f"\n\nKG: {len(corrections)} operator correction(s). "
                  f"Most recent: rejected {last.get('rejected')} → applied {last.get('applied')}.")

    system = (
        f"You are InfraBrain (gen-{gen}), an AI SRE assistant for a GPU datacenter.\n\n"
        f"Focus node: {node_id}\n"
        f"State: temp={node.get('temp','?')}°C  util={node.get('util','?')}%  "
        f"fan={node.get('fan','?')}%  mem={node.get('mem','?')}%"
        f"{inc_ctx}{kg_ctx}\n\n"
        "Rules:\n"
        "- Be concise (≤4 sentences). Ground answers in the current node state.\n"
        "- For action commands, confirm what was queued and its expected metric effect.\n"
        "- For questions (/explain, /history, /status), give a direct factual answer.\n"
        "- Never hallucinate telemetry values — if uncertain, say so."
    )

    try:
        client = _get_client()
        async for chunk in await client.aio.models.generate_content_stream(
            model=MODEL,
            contents=text,
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=300,
                temperature=0.4,
            ),
        ):
            if chunk.text:
                yield chunk.text

    except Exception as exc:
        yield f"[Agent error: {exc}. Check GEMINI_API_KEY and model availability.]"
