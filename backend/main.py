"""
InfraBrain backend — FastAPI + WebSocket + scripted agent (Gemini optional)

Architecture:
  WS  /api/stream  — bidirectional: server pushes ticks/incidents, client sends actions
  SSE /api/chat    — streaming SRE console responses (scripted by default)
  GET /api/kg      — knowledge graph snapshot
  GET /api/metrics — live metrics (override_rate, composite, mttr, hit_rate)
  POST/api/meta    — run meta-agent on latest traces

Run:
  pip install -r requirements.txt
  cp .env.example .env   # paste GEMINI_API_KEY
  python main.py         # live Gemini when key is set
"""

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import kg as kgdb
from agent import ask_agent_stream, diagnose, _fallback
from meta_agent import run as run_meta_agent
from metrics import compute_metrics
from simulator import FAULTS, FAULT_NODE, fresh_nodes, step_nodes

load_dotenv()


# ═══════════════════════════════════════════════════════════════════════════
#  SERVER STATE — single-process asyncio, no locks needed
# ═══════════════════════════════════════════════════════════════════════════

class SimState:
    def __init__(self):
        self.reset(gen=0)

    def reset(self, gen: int = 0):
        self.nodes:      list[dict] = fresh_nodes()
        self.t:          int        = 0
        self.incidents:  list[dict] = []
        self.repairs:    list[dict] = []
        self.log:        list[dict] = [{
            "t": 0, "kind": "sys", "node": None,
            "text": f"Simulator ready — gen-{gen}. Faults fire at t010 (R2-N5 fan) and t022 (R3-N2 mem).",
        }]
        self.agentGen:   int        = gen
        self.history:    dict       = {}   # node_id → [tick snapshots]
        self.episodes:   int        = 37
        self.running:    bool       = False
        self.traces:     list[dict] = []   # episode traces for meta-agent


sim = SimState()
clients: set[WebSocket] = set()


# ═══════════════════════════════════════════════════════════════════════════
#  BROADCAST HELPERS
# ═══════════════════════════════════════════════════════════════════════════

async def broadcast(msg: dict):
    dead = set()
    for ws in clients:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)


def _add_log(kind: str, text: str, node: str | None = None) -> dict:
    entry = {"t": sim.t, "kind": kind, "text": text, "node": node}
    sim.log.insert(0, entry)
    sim.log = sim.log[:100]
    return entry


async def _log(kind: str, text: str, node: str | None = None):
    entry = _add_log(kind, text, node)
    await broadcast({"type": "log", "entry": entry})


# ═══════════════════════════════════════════════════════════════════════════
#  SIMULATION TICK
# ═══════════════════════════════════════════════════════════════════════════

async def _sim_tick():
    sim.t += 1
    t = sim.t

    # Advance physics
    sim.nodes = step_nodes(sim.nodes, t, sim.repairs)

    # Update telemetry history
    for nd in sim.nodes:
        h = sim.history.setdefault(nd["id"], [])
        h.append({"t": t, "temp": nd["temp"], "util": nd["util"],
                   "fan": nd["fan"],  "mem":  nd["mem"]})
        if len(h) > 90:
            h.pop(0)

    # ── Repair countdown ────────────────────────────────────────────────
    remove_repairs: set[str] = set()

    for rep in sim.repairs:
        if rep["effectApplied"]:
            continue
        rep["ticksLeft"] -= 1
        if rep["ticksLeft"] <= 0:
            rep["effectApplied"] = True
            await _log("sys",
                f"Repair task {rep['taskId']} complete on {rep['node']} "
                f"— {rep['action']} applied. Monitoring post-fix window.",
                rep["node"])
            inc = _find_active_inc(rep["node"], stage="repairing")
            if inc:
                inc["stage"]       = "monitoring"
                inc["monitorFrom"] = t
                await broadcast({"type": "incident_update", "incident": inc})

    # ── Watcher — detect new faults ──────────────────────────────────────
    for fault in FAULTS:
        nd = next((n for n in sim.nodes if n["id"] == fault["node"]), None)
        if not nd:
            continue
        existing = _find_active_inc(fault["node"])
        if existing or t < fault["start"] or nd["temp"] < 75:
            continue

        inc_id = f"inc-{fault['node']}-{t}"
        new_inc = {
            "id":            inc_id,
            "node":          fault["node"],
            "faultType":     fault["type"],
            "stage":         "analyzing",
            "since":         t,
            "suggestion":    None,
            "monitorFrom":   None,
            "autoOverridden":False,
        }
        sim.incidents.append(new_inc)
        await _log("watch",
            f"Watcher: {fault['node']} temp {nd['temp']}°C fan {nd['fan']:.0f}% "
            f"mem {nd['mem']:.0f}% (z=3.4) — anomaly flagged.",
            fault["node"])
        await broadcast({"type": "incident_update", "incident": new_inc})
        # Fire LLM diagnosis async (non-blocking)
        asyncio.create_task(_run_diagnosis(new_inc))

    # ── Post-fix monitoring ───────────────────────────────────────────────
    for inc in list(sim.incidents):
        if inc["stage"] != "monitoring":
            continue
        rep = next(
            (r for r in sim.repairs if r["node"] == inc["node"] and r["effectApplied"]),
            None)
        nd  = next((n for n in sim.nodes if n["id"] == inc["node"]), None)
        if not (rep and nd):
            continue

        elapsed = t - (inc.get("monitorFrom") or 0)

        # ✓ Resolved
        if elapsed >= 6 and nd["temp"] < 75:
            await _log("sys",
                f"Resolved — {inc['node']} stable 6 ticks post-fix. Episode logged.",
                inc["node"])
            inc["stage"] = "resolved"
            remove_repairs.add(rep["taskId"])
            sim.episodes += 1
            _record_trace(inc, "resolved", mttr=float(t - (inc.get("since") or t)))
            await broadcast({"type": "incident_update", "incident": inc})
            await broadcast({"type": "episodes", "episodes": sim.episodes})

        # Scripted auto-override: fix ineffective (hero scenario gen-0 only)
        elif (nd["temp"] >= 92 and inc["node"] == FAULT_NODE
              and not inc.get("autoOverridden")):
            sug = inc.get("suggestion") or {}
            bad_action = sug.get("action", "throttle_job")
            await _log("watch",
                f"Post-fix: temp {nd['temp']}°C — {bad_action} ineffective. Override firing.",
                inc["node"])
            await _log("op",
                f"Override: rejected {bad_action}, applying ramp_fans. Correction → KG.",
                inc["node"])
            corr, _ = _write_correction(bad_action, "ramp_fans", inc["node"])
            _record_trace(inc, "override", sre_action="ramp_fans")
            if corr:
                await _broadcast_kg(corr)
            remove_repairs.add(rep["taskId"])
            new_rep = _make_repair(inc["node"], "ramp_fans", prefix=7000)
            sim.repairs.append(new_rep)
            inc["stage"]         = "repairing"
            inc["autoOverridden"]= True
            inc["suggestion"]    = {**sug, "overridden": True, "chosenAction": "ramp_fans"}
            await broadcast({"type": "incident_update", "incident": inc})

    sim.repairs = [r for r in sim.repairs if r["taskId"] not in remove_repairs]

    # ── Broadcast tick ────────────────────────────────────────────────────
    await broadcast({
        "type":      "tick",
        "t":         t,
        "nodes":     sim.nodes,
        "incidents": sim.incidents,
        "repairs":   sim.repairs,
        "episodes":  sim.episodes,
    })


async def _run_diagnosis(incident: dict):
    """LLM diagnosis task — runs after ~1.3 s (≈2 ticks) to mimic real latency."""
    await asyncio.sleep(1.3)

    nd = next((n for n in sim.nodes if n["id"] == incident["node"]), None)
    if not nd:
        return
    inc = next((i for i in sim.incidents if i["id"] == incident["id"]), None)
    if not inc or inc["stage"] != "analyzing":
        return  # already handled (reset, etc.)

    window = sim.history.get(incident["node"], [])
    try:
        result = await diagnose(nd, window, sim.agentGen)
    except Exception as exc:
        result = _fallback(nd, sim.agentGen, str(exc))

    inc["stage"]      = "suggested"
    inc["suggestion"] = result
    await _log("agent",
        f"Task agent (gen-{sim.agentGen}): {result['diagnosis']} → {result['action']} "
        f"(conf {result['conf']}). Awaiting SRE decision.",
        incident["node"])
    await broadcast({"type": "incident_update", "incident": inc})


# ── Helpers ───────────────────────────────────────────────────────────────

def _find_active_inc(node: str, stage: str | None = None) -> dict | None:
    for i in sim.incidents:
        if i["node"] != node or i["stage"] == "resolved":
            continue
        if stage is None or i["stage"] == stage:
            return i
    return None


def _make_repair(node: str, action: str, prefix: int = 4000) -> dict:
    return {
        "taskId":        f"rt-{prefix + sim.t}-{node.replace('-','')}",
        "node":          node,
        "action":        action,
        "ticksLeft":     4,
        "effectApplied": False,
    }


def _write_correction(rejected: str, applied: str, node: str):
    # No-op: same action means the agent was right — nothing to teach
    if rejected == applied:
        return None, None
    fan_action = applied in ("ramp_fans",)
    sig = f"temp↑/fan↓ @ {node}" if fan_action else f"temp↑/mem↑ @ {node}"
    corr = {
        "id":        f"corr-{int(time.time()*1000)}",
        "signature": sig,
        "rejected":  rejected,
        "applied":   applied,
        "context":   f"{node} gen-{sim.agentGen} t{sim.t:03d}",
        "source":    "operator_override",
    }
    kgdb.add_correction(corr)
    pair = {
        "ctx":      f"sig: {sig} t{sim.t:03d}",
        "rejected": rejected,
        "chosen":   applied,
        "source":   "operator_override",
    }
    kgdb.add_pair(pair)
    return corr, pair


def _record_trace(inc: dict, outcome: str, sre_action: str | None = None, mttr: float | None = None):
    sug = inc.get("suggestion") or {}
    trace = {
        "episode":   sim.episodes,
        "t":         sim.t,
        "node":      inc["node"],
        "faultType": inc["faultType"],
        "diagnosis": sug.get("diagnosis"),
        "suggested": sug.get("action"),
        "sreAction": sre_action or sug.get("action"),
        "outcome":   outcome,
        "composite": 0.55 if outcome == "override" else 0.72,
        "mttr":      mttr,
    }
    sim.traces.append(trace)
    kgdb.add_trace(trace)
    return trace


async def _broadcast_kg(corr: dict):
    pairs = kgdb.get_pairs()
    await broadcast({
        "type":           "kg_update",
        "correction":     corr,
        "pair":           pairs[-1] if pairs else None,
        "allCorrections": kgdb.get_corrections(),
    })


# ═══════════════════════════════════════════════════════════════════════════
#  SIMULATION LOOP
# ═══════════════════════════════════════════════════════════════════════════

async def _sim_loop():
    while True:
        if sim.running:
            await _sim_tick()
        await asyncio.sleep(0.65)


@asynccontextmanager
async def lifespan(app: FastAPI):
    kgdb.init_db()
    asyncio.create_task(_sim_loop())
    yield


# ═══════════════════════════════════════════════════════════════════════════
#  FASTAPI APP
# ═══════════════════════════════════════════════════════════════════════════

app = FastAPI(title="InfraBrain API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── WebSocket ─────────────────────────────────────────────────────────────

@app.websocket("/api/stream")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)

    # Send full initial state so the frontend can hydrate immediately
    await ws.send_json({
        "type":        "init",
        "t":           sim.t,
        "running":     sim.running,
        "agentGen":    sim.agentGen,
        "episodes":    sim.episodes,
        "nodes":       sim.nodes,
        "incidents":   sim.incidents,
        "repairs":     sim.repairs,
        "log":         sim.log[:40],
        "corrections": kgdb.get_corrections(),
        "pairs":       kgdb.get_pairs(),
    })

    try:
        while True:
            data = await ws.receive_json()
            await _handle_ws(data, ws)
    except WebSocketDisconnect:
        clients.discard(ws)
    except Exception:
        clients.discard(ws)


async def _handle_ws(msg: dict, ws: WebSocket):
    action = msg.get("type")

    # ── Episode reset ──────────────────────────────────────────────────
    if action == "reset":
        gen = int(msg.get("gen", 0))
        sim.reset(gen)
        await broadcast({
            "type":      "reset",
            "gen":       gen,
            "t":         0,
            "nodes":     sim.nodes,
            "incidents": [],
            "repairs":   [],
            "log":       sim.log[:5],
        })

    # ── Run / pause ────────────────────────────────────────────────────
    elif action == "set_running":
        sim.running = bool(msg.get("running", False))
        await broadcast({"type": "running", "running": sim.running})

    # ── SRE: accept suggestion ─────────────────────────────────────────
    elif action == "accept":
        inc_id = msg.get("incidentId")
        inc = next((i for i in sim.incidents if i["id"] == inc_id), None)
        sug = inc.get("suggestion") if inc else None
        if inc and sug:
            rep = _make_repair(inc["node"], sug["action"], prefix=4000)
            sim.repairs.append(rep)
            await _log("op",
                f"SRE ACCEPTED {sug['action']}. Repair task {rep['taskId']} queued on {inc['node']}.",
                inc["node"])
            inc["stage"] = "repairing"
            _record_trace(inc, "accepted", sre_action=sug["action"])
            await broadcast({"type": "incident_update", "incident": inc})
            await broadcast({"type": "repairs", "repairs": sim.repairs})

    # ── SRE: override ──────────────────────────────────────────────────
    elif action == "override":
        inc_id     = msg.get("incidentId")
        new_action = msg.get("action")
        inc = next((i for i in sim.incidents if i["id"] == inc_id), None)
        sug = inc.get("suggestion") if inc else None
        if inc and sug and new_action:
            await _log("op",
                f"SRE OVERRIDE: rejected {sug['action']}, applying {new_action}. Correction → KG.",
                inc["node"])
            corr, _ = _write_correction(sug["action"], new_action, inc["node"])
            rep  = _make_repair(inc["node"], new_action, prefix=5000)
            sim.repairs.append(rep)
            inc["stage"]      = "repairing"
            inc["suggestion"] = {**sug, "overridden": True, "chosenAction": new_action}
            _record_trace(inc, "override", sre_action=new_action)
            await broadcast({"type": "incident_update", "incident": inc})
            await broadcast({"type": "repairs",          "repairs":  sim.repairs})
            if corr:
                await _broadcast_kg(corr)

    # ── SRE: escalate ─────────────────────────────────────────────────
    elif action == "escalate":
        node_id = msg.get("node", "")
        await _log("op",
            f"SRE ESCALATED {node_id} → on-call (L2). PagerDuty incident opened.",
            node_id)
        await broadcast({"type": "escalation", "node": node_id,
                         "message": f"On-call paged for {node_id}. L2 SRE notified."})

    # ── SRE: cancel repair ────────────────────────────────────────────
    elif action == "cancel_repair":
        task_id = msg.get("taskId")
        sim.repairs = [r for r in sim.repairs if r["taskId"] != task_id]
        await _log("op", f"SRE cancelled repair task {task_id}.")
        await broadcast({"type": "repairs", "repairs": sim.repairs})

    # ── SRE: manual repair (from console /borg or /action) ────────────
    elif action == "queue_repair":
        node_id     = msg.get("node")
        action_name = msg.get("action")
        prefix      = int(msg.get("prefix", 6000))
        rep = _make_repair(node_id, action_name, prefix)
        sim.repairs.append(rep)
        await _log("op",
            f"SRE (console): queued {action_name} on {node_id} ({rep['taskId']}).",
            node_id)
        # Transition active incident to repairing if one exists
        inc = _find_active_inc(node_id, stage="suggested")
        if inc:
            inc["stage"] = "repairing"
            await broadcast({"type": "incident_update", "incident": inc})
        await broadcast({"type": "repairs", "repairs": sim.repairs})

    # ── SRE: re-run diagnosis ─────────────────────────────────────────
    elif action == "rediagnose":
        inc_id = msg.get("incidentId")
        inc = next((i for i in sim.incidents if i["id"] == inc_id), None)
        if inc and inc["stage"] in ("analyzing", "suggested"):
            inc["stage"] = "analyzing"
            inc["suggestion"] = None
            await broadcast({"type": "incident_update", "incident": inc})
            asyncio.create_task(_run_diagnosis(inc))


# ── SSE: streaming SRE chat ───────────────────────────────────────────────

class ChatRequest(BaseModel):
    text:      str
    focusNode: str
    incident:  Optional[dict] = None
    node:      Optional[dict] = None
    gen:       int = 0


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    node_state = req.node or next(
        (n for n in sim.nodes if n["id"] == req.focusNode), {})
    corrections = kgdb.get_corrections()
    context = {
        "focusNode":   req.focusNode,
        "incident":    req.incident,
        "node":        node_state,
        "corrections": corrections,
        "gen":         req.gen or sim.agentGen,
    }

    async def sse_stream():
        try:
            async for chunk in ask_agent_stream(req.text, context):
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'text': f'[Error: {exc}]'})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── REST: KG snapshot ────────────────────────────────────────────────────

@app.get("/api/kg")
async def get_kg():
    return {
        "corrections": kgdb.get_corrections(),
        "pairs":       kgdb.get_pairs(),
        "traces":      kgdb.get_traces(limit=20),
    }


@app.get("/api/kg/retrieve")
async def kg_retrieve(sig: str, k: int = 5):
    hits = kgdb.retrieve_similar(sig, k=k)
    return {
        "signature": sig,
        "hits": [
            {
                "sig":      h["correction"]["signature"],
                "sim":      h["sim"],
                "kind":     "correction",
                "rejected": h["correction"]["rejected"],
                "applied":  h["correction"]["applied"],
                "note":     f"{'exact-family match' if h['sim'] >= 0.9 else 'near-miss, same fault type'} — ranked #{i+1}",
            }
            for i, h in enumerate(hits)
        ],
    }


@app.get("/api/pairs")
async def get_pairs():
    return {"pairs": kgdb.get_pairs()}


# ── REST: live metrics ───────────────────────────────────────────────────

@app.get("/api/metrics")
async def get_metrics():
    traces      = kgdb.get_traces(limit=200)
    corrections = kgdb.get_corrections()
    metrics     = compute_metrics(traces, corrections, sim.agentGen, sim.episodes)
    metrics["pairsCount"] = len(kgdb.get_pairs())
    return metrics


# ── REST: KG document ingestion ─────────────────────────────────────────

class IngestRequest(BaseModel):
    url:      Optional[str] = None
    text:     Optional[str] = None
    filename: Optional[str] = None


@app.post("/api/kg/ingest")
async def kg_ingest(req: IngestRequest):
    """
    Feed a document (URL or raw text) to Gemini; it extracts failure patterns
    (symptoms → causes → actions) and persists them as new KG nodes/edges.
    """
    import httpx

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key or api_key.endswith("..."):
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not configured in backend/.env")

    # ── 1. Resolve text content ───────────────────────────────────────────
    text = req.text or ""
    source = req.url or req.filename or "direct-input"

    if req.url and not req.text:
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                r = await client.get(req.url, headers={"User-Agent": "InfraBrain/1.0"})
                r.raise_for_status()
                text = r.text
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not fetch URL: {exc}")

    if not text.strip():
        raise HTTPException(status_code=422, detail="No text content to ingest")

    text = text[:10_000]  # Gemini context window budget

    # ── 2. Gemini extraction ──────────────────────────────────────────────
    from google import genai as gai
    from google.genai import types as gai_types

    client = gai.Client(api_key=api_key)

    extraction_prompt = f"""You are analyzing a document about GPU datacenter / infrastructure failures.
Extract failure knowledge for a diagnostic knowledge graph.

Return ONLY valid JSON matching this schema exactly:
{{
  "nodes": [
    {{"id": "snake_case_id", "label": "2-4 word name", "kind": "symptom|cause|action", "description": "one sentence"}}
  ],
  "edges": [
    {{"from_id": "node_id", "to_id": "node_id", "label": "short relationship"}}
  ],
  "summary": "1-2 sentence summary of what was extracted"
}}

Rules:
- "symptom" = observable signal (e.g. temp spike, util drop, ECC errors)
- "cause"   = root cause diagnosis (e.g. fan failure, memory leak, NIC fault)
- "action"  = remediation step (e.g. ramp_fans, drain_node, checkpoint_restart)
- Extract at most 12 nodes and 18 edges
- Use snake_case ids (e.g. "thermal_throttle", "fan_failure", "ramp_fans")
- Do not include generic or non-infrastructure content

Document:
{text}"""

    try:
        resp = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=extraction_prompt,
            config=gai_types.GenerateContentConfig(
                response_mime_type="application/json"
            ),
        )
        data = json.loads(resp.text)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Gemini extraction failed: {exc}")

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    summary = data.get("summary", "")

    # ── 3. Persist to DB ──────────────────────────────────────────────────
    for node in nodes:
        node["source"] = source
        kgdb.add_doc_node(node)
    for edge in edges:
        kgdb.add_doc_edge(edge, source=source)

    # Broadcast update to connected clients so the KG tab refreshes
    await broadcast({"type": "kg_doc_update", "nodes": len(nodes), "edges": len(edges)})

    return {
        "added":   len(nodes),
        "edges":   len(edges),
        "summary": summary,
        "source":  source,
        "nodes":   nodes,
    }


# ── REST: KG reset ──────────────────────────────────────────────────────

@app.post("/api/kg/reset")
async def kg_reset():
    """Clear all corrections, pairs, traces, and ingested doc nodes/edges."""
    import sqlite3
    conn = sqlite3.connect(kgdb.DB_PATH)
    conn.executescript("""
        DELETE FROM corrections;
        DELETE FROM pairs;
        DELETE FROM traces;
        DELETE FROM kg_doc_nodes;
        DELETE FROM kg_doc_edges;
    """)
    conn.commit()
    conn.close()
    await broadcast({"type": "kg_reset"})
    return {"ok": True, "message": "KG cleared — seed taxonomy preserved in memory."}


# ── REST: meta-agent ────────────────────────────────────────────────────

@app.post("/api/meta")
async def run_meta():
    result = await run_meta_agent(sim.traces or kgdb.get_traces(), sim.agentGen)
    return result


# ── REST: current state ─────────────────────────────────────────────────

@app.get("/api/state")
async def get_state():
    return {
        "t":         sim.t,
        "running":   sim.running,
        "agentGen":  sim.agentGen,
        "episodes":  sim.episodes,
        "nodes":     sim.nodes,
        "incidents": sim.incidents,
        "repairs":   sim.repairs,
    }


# ── Entry point ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8002))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
