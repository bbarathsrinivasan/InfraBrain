# Backend — how to turn the demo into a live system

The current repo is **frontend-only**: the simulator, the "agent," the KG, and all metrics live in `src/InfraBrainApp.jsx` as deterministic scripted state. This doc describes the backend that replaces the scripted pieces with real services, and exactly which frontend seams to cut.

---

## What is real vs. scripted today

| Piece | Today (frontend) | Backend replacement |
|-------|------------------|---------------------|
| Fault simulator | `stepNodes()` in-browser, 650 ms tick | Python sim service, authoritative clock, streams telemetry |
| Watcher | inline `temp>=75` check | statistical anomaly detector (z-score / EWMA) as a service |
| Task agent | `buildSuggestion()` scripted | LLM call (Gemini API) with KG-augmented prompt |
| Knowledge graph | `kgCorr` array in React state | graph store (SQLite/Postgres + embeddings, or a graph DB) |
| Meta-agent | static `META_DIFF` string | offline job that rewrites task-agent code from traces |
| SRE chat | `askAgent()` scripted responder | same LLM endpoint, streaming |
| Preference pairs | `pairs` array | append-only JSONL store / table |

The frontend already isolates the two seams that matter most:
- **`askAgent(ctx)`** — one function, documented in-file as the LLM drop-in. Replace its body with a `fetch` to `/api/chat`.
- **`buildSuggestion(nodes, gen, faultType, node)`** — the diagnosis call. Replace with a `fetch` to `/api/diagnose`.

Everything else (incident state machine, focus switcher, panels) can stay client-side and simply consume server events.

---

## Target architecture

```
┌────────────┐   telemetry (WS)    ┌──────────────┐
│  Simulator │ ──────────────────► │              │
│  service   │                     │   Backend    │
└────────────┘                     │   (FastAPI)  │
     ▲  applies repairs            │              │
     │                             │  /diagnose ──┼──► Task Agent (LLM) ──► KG retrieval
┌────┴───────┐   incidents (WS)    │  /chat       │
│  Watcher   │ ──────────────────► │  /override ──┼──► KG write + pair export
│ (z-score)  │                     │  /repair     │
└────────────┘                     │  /metrics    │
                                   └──────┬───────┘
        React UI  ◄──────────────────────┘
                                   ┌──────────────┐
   offline, nightly:              │  Meta-agent   │ reads traces → rewrites
   traces ──────────────────────► │  evolution    │ task-agent code → held-out gate
                                   └──────────────┘
```

Suggested stack (matches the sibling `pact-business` project): **FastAPI** backend, **WebSocket** for live telemetry/incident push, **SQLite → Postgres** for the KG and trace store, **Gemini API** for the task agent + SRE chat.

---

## API surface (proposed)

```
GET   /api/fleet                  → current node states (bootstrap)
WS    /api/stream                 → telemetry ticks + incident stage changes
POST  /api/diagnose               → { node } → { diagnosis, action, conf, evidence[] }
POST  /api/chat                   → { text, focusNode } → streamed agent reply
POST  /api/incident/{id}/accept   → queue repair task
POST  /api/incident/{id}/override → { action } → write KG correction + export pair
POST  /api/repair                 → { node, action } (manual /borg)
POST  /api/escalate               → { node } → page on-call
GET   /api/kg                     → nodes + edges + corrections
GET   /api/kg/retrieve?sig=...    → top-k corrections (retrieval trace)
GET   /api/metrics                → override_rate, mttr, hit_rate, composite, gen_scores
POST  /api/episode/reset          → { gen } → new episode
GET   /api/pairs                  → preference pairs (JSONL)
```

---

## The task agent (`/api/diagnose`)

This is the LLM call. The KG-augmented prompt is the whole trick:

```python
async def diagnose(node_id: str, gen: int):
    window = telemetry.window(node_id, ticks=12)          # recent temp/util/fan/mem
    sig    = signature(window)                             # e.g. "temp↑/fan↓ @ R2-N5"
    hits   = kg.query_similar(sig, k=5)                    # Loop 1: retrieval
    hits.sort(key=lambda h: (h.kind != "correction", h.age))

    prompt = build_prompt(window, hits, gen)               # meta-agent evolves this
    resp   = await gemini.generate_content(..., response_mime_type="application/json")
    return DiagnoseResult(diagnosis=..., action=..., conf=..., evidence=[...])
```

- **Retrieval** (`kg.query_similar`) is Loop 1. Corrections ranked above seed rules.
- The **prompt template** and the **retrieval/ranking code** are exactly what the meta-agent rewrites (Loop 3). Keep them in a single versioned module (`agents/genN/diagnose.py`) so a diff is meaningful.
- Ask for **structured output** (JSON) so `action` maps cleanly to the repair executor and `evidence` renders in the incident panel.

---

## The knowledge graph

Minimal schema:

```sql
node(id, kind, label)                              -- symptom|cause|action|correction
edge(from_id, to_id, kind)                         -- seed|correction
correction(id, signature, embedding, rejected,
           applied, context, source, created_at)   -- the amber nodes
```

- **Write path** (`/override`): insert a `correction` row + edges, embed the signature. This is Loop 2 — the only write that "teaches" without training.
- **Read path** (`kg.query_similar`): cosine over `embedding`, filter by kind, return top-k. No separate vector DB needed at this scale — `sqlite-vec` / `pgvector` is enough.
- **Auditability:** because corrections are rows, a bad lesson is a `DELETE`, not an un-training run. This is the safety story — keep `created_at`, `source`, and who approved it.

---

## The meta-agent (offline evolution, Loop 3)

Runs as a batch job, not in the request path:

1. **Collect** the last N episode traces (telemetry window, agent suggestion, SRE decision, outcome, per-term reward).
2. **Diagnose failures** — cluster the misses (e.g. "6/9 were near-miss signatures").
3. **Propose a diff** to `agents/genN/diagnose.py` (retrieval, ranking, or prompt).
4. **Evaluate** the new variant on the **train** fault families; score the **composite**.
5. **Gate** on the **held-out** composite — accept only if it improves; else archive as rejected.
6. **Archive** every variant with parent + score; select next parents by score × exploration.

See [METRICS_AND_LEARNING.md](METRICS_AND_LEARNING.md) §2.2 for the metric→diff mapping.

---

## Metrics service (`/api/metrics`)

Compute from the trace store, not the UI:

```python
override_rate = overrides / incidents                       # rolling window
mttr          = mean(resolved_tick - detected_tick)
hit_rate      = incidents_with_matching_correction / incidents_with_relevant_correction
composite     = 0.40*correct + 0.25*mttr_score + 0.20*(1-override_rate) + 0.15*safety
```

The frontend charts read these directly. The composite is **the same function** the meta-agent optimizes and GRPO will later use as reward — define it once, server-side, and import it everywhere.

---

## Data ingestion — grounding on real failures

The demo's simulator is synthetic. To ground it (and answer "where's the data?"):

- **Alibaba GPU Cluster Trace** — downloadable; replay real job/resource load into the simulator instead of synthetic `job-*`. This is the realistic first ingestion.
- **Microsoft Philly / Borg traces** — failure and eviction patterns to seed fault schedules.
- **OPT-175B logbook, BLOOM/Llama-3 logs** — mine documented failure classes (thermal, memory, NIC, power, NCCL hangs) to seed the KG's `cause` taxonomy and RUNBOOKS.
- **TPU note:** no public TPU crash dataset exists (that data is internal to Google). GPU pretraining failures are the honest proxy — same failure classes, same operator-override dynamics.

Ingestion writes to the same telemetry stream and KG seed tables the simulator uses, so the UI is unchanged.

---

## Migration checklist (frontend → live)

1. Stand up FastAPI + WS; move `stepNodes` to a Python sim service.
2. Point the React interval at `WS /api/stream` instead of the in-browser `setInterval`.
3. Replace `buildSuggestion` → `POST /api/diagnose`; `askAgent` → `POST /api/chat`.
4. Back the KG with `pgvector`; wire `/override` to write corrections + export pairs.
5. Emit traces on every episode; stand up the metrics service.
6. Add the offline meta-agent job + held-out eval harness.
7. (Later) DPO on pairs, then GRPO against the simulator reward.
