# InfraBrain — Implementation Details

## Architecture Overview

Five backend modules (`simulator.py`, `agent.py`, `kg.py`, `meta_agent.py`, `metrics.py`) wired together by a FastAPI server (`main.py`). A Vite/React frontend connects over WebSocket and SSE. All persistent state (KG, preference pairs, episode traces) lives in a single SQLite file (`infrabrain.db`).

---

## Simulator (`simulator.py`)

**Thermal dynamics per tick:**

```
dT = 0.085 × util − 0.082 × fan + mem_heat + noise
```

Temperature clamped 45–104 °C. 32 nodes across 4 racks. Each tick represents approximately 30 seconds of real datacenter time — a 90-tick episode maps to roughly 45 minutes, which is a realistic window for a thermal incident to develop and resolve.

**Fan degradation fault:** fan speed decreases 3 % per tick after fault injection — representing a bearing failure that degrades over roughly 15–20 minutes of real time before becoming critical.

**Thermal throttling:** kicks in above 88 °C; utilisation multiplied by 0.93 per tick. This is the deceptive symptom — utilisation dropping under heat looks identical to a CPU idle or job completion event, which is why naive agents misdiagnose it. The 88 °C threshold mirrors NVIDIA's documented throttle point for A100 and H100 GPUs.

**Workload seed:** job arrival rates, utilisation distributions, and burst characteristics are seeded from Alibaba GPU cluster traces. The traces contain no fault labels — used purely to make background load realistic rather than uniform. The simulator is deterministic given a seed, which makes gen-0 vs gen-4 A/B comparisons honest: both agents see the identical fault timeline.

---

## Composite Score Formula

```
score = 0.35 × diagnosis_accuracy
      + 0.25 × (1 − false_remediation_rate)
      + 0.20 × (1 − normalised_MTTR)
      + 0.20 × (1 − time_to_recurrence)
```

**Diagnosis accuracy (0.35 — highest weight):** Getting root cause right is the prerequisite for everything else. A correct diagnosis with a slow fix is recoverable; a wrong diagnosis with a fast fix makes things worse — you've applied a wrong intervention to a degrading system. Correct root cause identification is the primary metric in real AIOps evaluation.

**False remediation rate (0.25):** An action that worsens system state — throttling a job when the real problem is a fan — consumes SRE time, delays the correct fix, and can accelerate hardware damage. Penalised more than MTTR because the cost is multiplicative: a wrong fix adds its own resolution time on top of the original incident.

**Normalised MTTR (0.20):** Mean Time To Resolution normalised against a 30-tick ceiling (~15 min real time). Standard SRE metric per Google's SRE handbook. Lower weight than accuracy because a slower correct fix always beats a fast wrong one.

**Time to recurrence (0.20):** How long after the fix before the same fault reappears, normalised against 60 ticks (~30 min). Catches fixes that mask symptoms rather than address root cause — throttling the job reduces heat temporarily, but the fan is still failing. Recurring incidents indicate systemic failure and are penalised heavily in real datacenter SLAs.

The weights (0.35 / 0.25 / 0.20 / 0.20) reflect the cost hierarchy in AIOps literature: diagnosis as the gate, false remediation as the multiplier, MTTR and recurrence as operational outcomes.

---

## Watcher (`main.py` — `_sim_tick`)

Statistical z-score on temperature. Fires when `temp ≥ 75 °C` **and** z-score crosses **3.4 standard deviations** from a rolling 20-tick baseline.

- **3.4σ threshold** → ~0.03 % false positive rate. Chosen to avoid alert fatigue, a documented critical failure mode in real AIOps deployments.
- **No LLM in the watcher** — intentional. LLM-as-watcher would add 500–2000 ms latency per tick; at 30-second tick intervals the watcher must be near-instantaneous. Also avoids reward hacking: if the LLM controlled anomaly detection it could influence which incidents it sees.

---

## Task Agent (`agent.py`)

Calls **Gemini Flash** (`gemini-flash-latest`). Prompt constructed at incident time from three components:

1. **Telemetry window** — last 10 ticks of temp, util, fan for the affected node (~5 minutes real time)
2. **Top-k KG corrections** — retrieved by Jaccard similarity against the current symptom signature (k=5 by default); corrections ranked before general triples
3. **Fixed action vocabulary** with descriptions

**Output schema:** structured JSON — `{diagnosis, action, confidence, evidence[]}`.

The `evidence` array is mandatory in the prompt instruction. The model cannot return a suggestion without citing which telemetry features and KG records it used — this makes auditability structural, not optional.

**Fixed action vocabulary:** `ramp_fans`, `throttle_job`, `migrate_workload`, `drain_node`, `restart_node`, `escalate`, `no_action`. Unconstrained prose suggestions are untestable and unexecutable. This vocabulary maps directly to real datacenter operations that can be scripted and queued automatically.

**Scripted fallback:** when `GEMINI_API_KEY` is unset or `USE_SCRIPTED_AGENT=true`, `agent.py` returns a deterministic Bernoulli draw from per-generation accuracy tables. This lets the simulator and eval harness run without API calls for reproducible baseline testing.

---

## Knowledge Graph (`kg.py`)

NetworkX-style graph persisted in SQLite (`infrabrain.db`).

**Node types:** symptom signatures, root causes, remediation actions.

**Edge types:**
- `indicates` — symptom → cause
- `resolves` — cause → action
- `rejected_for` — records what was tried and failed

**Seed content:** 15 hand-written triples covering 8 scenario families — enough to give the agent a starting point, extracted from postmortem documents and playbooks that any mature datacenter team already has.

**Override record schema:** `{symptom_signature, rejected_action, applied_action, context, timestamp}`. Written immediately on SRE override — no batching, no delay. Queryable by the task agent within the same episode if a second incident fires.

**Retrieval:** Jaccard similarity over the symptom signature — a structured feature vector (`{temp_slope: high, fan_pct: low, util_trend: falling, memory_pressure: normal}`), not prose. Jaccard over categorical/boolean features is more appropriate than cosine similarity over embeddings here: embedding distance would treat `temp_slope: high` and `temp_slope: moderate` as more similar than they are diagnostically.

---

## Meta-Agent (`meta_agent.py`)

Reads episode traces (overrides, fault types, wrong actions), proposes a code diff for the task agent's retrieval and prompting logic, and returns a projected improvement estimate.

**Live mode:** calls `gemini-flash-latest` with the current generation's code, batch statistics, and a sample of override traces. Returns `{diff, explanation, projectedImprovement, newGen}` as structured JSON.

**Scripted fallback:** deterministic output based on override rate and dominant fault type — used when no API key is set, for reproducible demos.

The meta-agent does **not** deploy its own diff. It proposes the change; the eval gate (`infrabrain-eval`) validates it across 120 live Gemini API calls before the new generation is accepted. Gen-5's CRITICAL NOTE regression was caught this way — the diff was blocked before deployment.

**Triggered by:** `POST /api/meta` — called manually from the SRE console or at the end of an episode batch.

---

## Learning Loop Timeframes

| Loop | Latency | Trigger |
|------|---------|---------|
| KG retrieval | seconds (query time) | Watcher fires → agent queries KG |
| KG correction write | immediate on override | SRE clicks Override → SQLite write |
| Meta-agent rewrite | offline, ~8–12 min compute | After episode batch (~20 episodes) |
| DPO fine-tuning | future — after ~500–1000 pairs | Not yet implemented |

Per-incident and per-override loops have no batch window — they are online and immediate. A correction written 5 minutes ago in the same session is already retrievable for the next incident.

The meta-agent fires after a full episode batch, not after every episode. At 45 minutes per episode (real-time equivalent), one generation cycle represents roughly 15 hours of operational data in a production deployment. In the simulator with compressed time, this runs in minutes.

DPO fine-tuning is the next engineering step. The preference pair export is live; the training loop is not yet implemented. Trigger target: ~500–1000 pairs, which at current override rates would take several weeks of production operation.

---

## API — FastAPI + WebSocket (`main.py`)

**WebSocket** — `GET /api/stream`

Four event types broadcast to all connected clients:

| Event | Payload |
|-------|---------|
| `tick` | Full node state update, every 650 ms (demo) |
| `incident` | Watcher trigger, agent suggestion, SRE decision |
| `repair` | Task queued → executing → complete → post-fix assessment |
| `kg_update` | Correction written, graph delta |

Frontend reconnects automatically on WebSocket drop with exponential backoff.

**SSE** — `POST /api/chat`

SRE console chat streams Gemini responses token-by-token via Server-Sent Events. Necessary because Gemini Flash at full reasoning depth takes 3–5 seconds per response — a blocked UI for that duration is unusable in an incident context.

**REST endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/kg` | Full KG dump |
| `GET` | `/api/kg/retrieve?sig=…&k=5` | Live similarity retrieval |
| `POST` | `/api/kg/ingest` | Manual triple ingestion |
| `POST` | `/api/kg/reset` | Reset KG to seed triples |
| `GET` | `/api/pairs` | All preference pairs |
| `GET` | `/api/metrics` | Current session metrics |
| `POST` | `/api/meta` | Trigger meta-agent rewrite |
| `GET` | `/api/state` | Full simulation state snapshot |

---

## Preference Pairs

Written to SQLite immediately on every override:

```json
{
  "id": "...",
  "context": "symptom_signature + telemetry window summary + episode seed",
  "rejected": "throttle_job",
  "chosen": "ramp_fans",
  "source": "operator_override"
}
```

237 pairs from prior evaluation runs plus live session pairs. Context includes the full symptom signature, telemetry window summary, and episode seed — enough to reconstruct what the agent saw when it made the wrong call.

This is the DPO training format exactly as specified in Rafailov et al. 2023 — no transformation required, direct input to a fine-tuning run on Gemma or any other model.

---

## Eval Gate (`infrabrain-eval/`)

Separate harness — not part of the main backend. Runs after the meta-agent proposes a diff to validate the new generation before it ships.

- **120 live Gemini 3.5 Flash API calls** — 20 episodes × 6 generations
- **Train / holdout split** — 60 % training scenarios, 40 % held-out scenarios the meta-agent never sees
- Computes the same composite score formula as the simulator
- Blocks a new generation if holdout score regresses from the current generation's baseline

The gen-5 CRITICAL NOTE regression (holdout 0.94 → 0.68) was caught here. Without the eval gate, that regression would have shipped.

Results written to `results/llm_gen_scores.json`. The frontend's generation score chart (`GEN_DATA` in `InfraBrainApp.jsx`) is populated from this file.
