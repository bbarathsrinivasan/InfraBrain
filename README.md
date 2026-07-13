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

## What's in this repo today (frontend demo)

A **frontend-only React demo** with scripted/synthetic data that makes the full loop tangible. No backend, no live LLM calls yet — everything is deterministic so it demos reliably.

Four tabs:

- **Observability** — live fleet grid (4 racks × 8 nodes), multi-incident queue with a shared focus switcher, telemetry strips, incident panel with Accept/Override, repair-task queue, blast-radius + runbook, event log, and an **SRE console** (free-text Q&A + `/` command palette: `/diagnose /explain /ramp_fans /migrate /borg /escalate …`).
- **Learning Lab** — override-rate curve, meta-agent composite-score curve (train vs held-out), the actual gen-3→gen-4 code diff, per-scenario-family generalization, composite-reward decomposition, and the variant archive.
- **Knowledge Graph** — SVG graph (amber = operator corrections), retrieval trace, KG stats with retrieval hit-rate.
- **Training Data** — preference-pair list, JSONL schema, dataset composition, 3-phase deployment story, and the **failure data-sources** panel (real GPU/pretraining corpora).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Requires Node 18+. Stack: Vite + React 18 + Recharts.

**Try this:** hit `▶ Gen-0 episode`, let the faults fire (t10 fan on R2-N5, t22 memory on R3-N2), watch gen-0 misdiagnose, then hit `▶ Gen-4 replay` to see the corrected diagnosis with KG evidence.

---

## Key design decisions (locked)

- **Suggest-only.** The agent never remediates autonomously — an SRE Accepts or Overrides. Every action is human-gated.
- **Non-parametric memory.** Corrections live in a knowledge graph, not model weights: no catastrophic forgetting, every lesson auditable and reversible.
- **Statistical watcher** (not an LLM) for anomaly detection — cheap, fast, always-on.
- **No vector DB** — the KG handles retrieval.
- **Alibaba GPU traces** used for workload *replay* only, never as a supervision signal.

See **[docs/METRICS_AND_LEARNING.md](docs/METRICS_AND_LEARNING.md)** for the metrics we track and exactly how they drive model/agent updates, and **[docs/BACKEND.md](docs/BACKEND.md)** for the plan to turn this demo into a live system.

## Reference

Hyperagents (arXiv 2603.19461) — DGM-Hyperagents: a task agent and a meta agent in one editable program. The meta agent rewrites the task-agent code from episode traces; an archive of all variants is kept, parents are selected by score × exploration, and a train/held-out split measures generalization.
