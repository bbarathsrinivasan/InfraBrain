# InfraBrain

**A self-improving diagnostic agent for GPU datacenter racks that learns from operator overrides, runs on a fault-injection simulator, and improves its own diagnostic code via a meta-agent evolution loop — with every improvement verified on held-out fault scenarios.**

Track 2: Developer Productivity & Tooling (infrastructure debugging).

---

## The one-paragraph pitch

When a GPU training node overheats, the *deceptive* symptom (utilization drops from thermal throttling) looks exactly like the *wrong* root cause (CPU overload). A naive agent throttles the job and the rack keeps cooking. InfraBrain shows an agent that (1) gets this wrong at gen-0, (2) learns the correct diagnosis the first time a human SRE overrides it, (3) stores that correction in an auditable knowledge graph so it never repeats the mistake, and (4) has its *diagnostic code rewritten by a meta-agent* across generations — with the improvement measured as a number on fault scenarios it never trained on.

Three learning loops, three timescales:

| Loop | Timescale | Mechanism | What changes |
|------|-----------|-----------|--------------|
| **Retrieval** | seconds (per incident) | KG similarity lookup | context only — weights frozen |
| **Memory** | minutes (per override) | correction written to KG | non-parametric knowledge |
| **Evolution** | offline (per generation) | meta-agent rewrites task-agent code | the agent program itself |

---

## Run it

```bash
# Frontend only (demo mode — in-browser sim + scripted fallback)
npm install
npm run dev        # http://localhost:5175

# Full stack (real Gemini LLM + Python sim)
cp backend/.env.example backend/.env   # add GEMINI_API_KEY
cd backend && pip install -r requirements.txt && python main.py
# Then set VITE_BACKEND_WS / VITE_BACKEND_HTTP in .env and npm run dev
```

Requires Node 18+. Stack: Vite + React 18 + Recharts. Backend: FastAPI + SQLite + Gemini API.

**Try this:** hit `▶ Gen-0 episode`, let the faults fire (t010 fan on R2-N5, t022 memory on R3-N2), watch gen-0 misdiagnose fan failure as CPU overload, then hit `▶ Gen-4 replay` to see the corrected diagnosis with KG evidence cited.

---

## What is real vs. simulated/hardcoded

Use this table when explaining the demo to judges.

| Component | Status | Detail |
|-----------|--------|--------|
| **Fault simulator** | ✅ Real (Python) | Thermal model `dT = 0.085·util − 0.082·fan + mem_heat + noise`; fan decay −3%/tick; mem leak +2.4%/tick. Seeded, deterministic. |
| **Watcher** | ✅ Real | z-score anomaly detection in backend; inline temp threshold in frontend demo mode. |
| **Task Agent (diagnosis)** | ✅ Real (Gemini API) | `gemini-2.0-flash`, KG-augmented prompt, structured JSON output. Falls back to scripted if API unavailable. |
| **Knowledge Graph** | ✅ Real (SQLite) | Corrections persist across episodes. Jaccard similarity retrieval. Backend: `kg.py`. |
| **Meta-Agent** | ✅ Real (Gemini API) | Reads episode traces, clusters failures, proposes unified diff. `POST /api/meta` triggers it. |
| **SRE Console chat** | ✅ Real (Gemini streaming) | SSE streaming, system prompt includes node state + active incident + KG corrections. |
| **WebSocket telemetry** | ✅ Real | Backend pushes tick/incident/repair events; frontend reconnects on drop. |
| **Override rate chart** | 🟡 Simulated history | 40-episode mock history showing realistic decay with spikes at new fault classes. Live overrides do update KG + pairs. |
| **Composite score / gen curves** | 🟡 Static mock | `GEN_DATA` in JSX — shows gen-0→5 improvement. Reflects real architecture, not live runs. |
| **Agent version history** | 🟡 Realistic mock | `src/versions/gen{0-5}.json` — real diffs, real metrics, real known-failure progression. Not auto-generated at runtime. |
| **"gen-5 deployed" indicator** | 🟡 Simulated | Episodes run as gen-0 or gen-4 per button. `gen5.json` prompt is what `agent.py` actually uses. |
| **Alibaba trace workload** | 🟡 Partial | Job names (`job-1009(trace)` etc.) reference the trace. Full replay needs ingestion pipeline — roadmap item. |
| **DPO / GRPO training** | 🔴 Future scope | Preference pairs export is live. Training loop not implemented — needs more episodes and a fine-tuning run. |

---

## Three-phase production deployment

*(Moved from the Training Data tab — reference for presentation)*

**Phase 01 — Shadow mode**
Seed KG from postmortems and playbooks. Run in shadow mode against fault-injection tooling — accumulate corrections before touching live SREs. No operator impact.

**Phase 02 — Suggest-only with SREs** ← *This demo is Phase 02*
Agent suggests, SRE decides. Every override writes a correction to the KG and exports a preference pair. Override rate falls as KG grows. The agent never acts autonomously.

**Phase 03 — DPO / GRPO training**
Finetune a small model (3–8B, LoRA) via DPO on the accumulated preference pairs. Gate on held-out regression before deploy. GRPO against the simulator's composite reward is the next step after DPO.

> **Why not RL now?** Two days → not enough episodes for stable RL. Preference pairs are the honest bridge. The simulator IS the RL environment — nothing new to build when we get there.

---

## Key design decisions

- **Suggest-only.** The agent never remediates autonomously — an SRE Accepts or Overrides. Every action is human-gated.
- **Non-parametric memory.** Corrections live in a knowledge graph, not model weights: no catastrophic forgetting, every lesson auditable and reversible. A bad lesson is a `DELETE`, not an un-training run.
- **Statistical watcher** (not an LLM) for anomaly detection — cheap, fast, always-on.
- **Deceptive symptom by design.** Fan failure → thermal throttling → util *drops* → gen-0 reads this as CPU idle and misdiagnoses. Gen-5 has an explicit CRITICAL DIAGNOSTIC NOTE in its prompt. This is the story arc of the demo.
- **Held-out eval gate.** Meta-agent code proposals are only accepted if the held-out composite score improves. Prevents the meta-agent from memorising training scenarios.

---

## Docs

- **[docs/METRICS_AND_LEARNING.md](docs/METRICS_AND_LEARNING.md)** — composite reward formula, how each metric drives model/agent updates, DPO/GRPO roadmap
- **[docs/BACKEND.md](docs/BACKEND.md)** — API surface, KG schema, meta-agent design, migration checklist

## Reference

Hyperagents (arXiv 2603.19461) — DGM-Hyperagents: a task agent and a meta agent in one editable program. The meta agent rewrites the task-agent code from episode traces; an archive of all variants is kept, parents selected by score × exploration, and a train/held-out split measures generalisation.
