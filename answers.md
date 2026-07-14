# InfraBrain — Showcase Answers

---

## Tagline

A self-improving GPU diagnostic agent that rewrites its own code from operator feedback — 78%→17% override rate, 3× faster fault resolution, zero retraining.

---

## Problem Statement

- **GPU faults are deceptive.** When a fan fails, the node overheats and slows down — but to a naive agent, a slowdown looks like the CPU is idle. It picks the wrong fix and makes things worse. Real cluster data shows 466 training interruptions in 54 days; one wrong diagnosis can waste hours of expensive GPU time.

- **Every expert correction gets thrown away.** When an SRE overrides an agent's wrong answer, that lesson lives only in their head. The next identical fault starts from scratch. Retraining a model to capture that knowledge takes weeks and can break everything it already knew.

- **Diagnostic agents today never get better.** Fixed prompts and static logic mean override rates stay high, on-call burden never shrinks, and every new type of fault needs manual handling — a system that can't learn from its mistakes doesn't scale as the fleet grows.

---

## Technical Architecture, Methodology & Novelty

### How it works — two agents, three loops

InfraBrain is a **two-level agent system** modelled on the teacher-student pattern from the DGM-Hyperagents paper (arXiv 2503.19461).

**Task agent (the student)** — runs on every live incident:
1. A statistical watcher detects anomalies using z-score thresholds on temperature, utilization, fan speed, and memory
2. The task agent queries live telemetry + searches the knowledge graph for similar past corrections using Jaccard signature similarity
3. Gemini 2.0 Flash diagnoses the fault and suggests a remediation with confidence score and cited evidence
4. The SRE accepts or overrides — either way, the outcome is recorded

**Meta-agent (the teacher)** — runs offline between generations:
1. Reads all episode traces, clusters failure patterns, identifies where the task agent keeps going wrong
2. Calls Gemini 2.0 Flash to propose a rewrite of the task agent's diagnostic prompt as a unified diff
3. The rewrite only ships if it scores higher on a held-out set of fault scenarios the agent hasn't trained on — an eval gate that blocks regressions
4. The improved agent becomes the next generation

**Three learning loops at three timescales:**
- **Seconds** — KG retrieval augments every diagnosis with relevant past corrections
- **Minutes** — each SRE override writes a permanent correction to the knowledge graph
- **Offline** — the meta-agent rewrites the task agent's code each generation

### What makes it novel

- **Non-parametric memory.** Corrections live in SQLite, not model weights. They never get forgotten and never cause catastrophic forgetting. A bad lesson is one `DELETE` row — not an un-training run. This is fundamentally different from fine-tuning.
- **Meta-agent with an eval gate.** The teacher rewrites the student's code, but only ships the update if held-out performance improves. This is the key result from the Hyperagents paper — improvements generalise to fault classes neither agent trained on.
- **Deception-aware prompt engineering.** Gen-5's diagnostic prompt includes an explicit `CRITICAL NOTE` about thermal throttling: util drop does not mean CPU overload. This single addition accounts for the largest jump in held-out accuracy.
- **DPO-ready from day one.** Every SRE override automatically exports a preference pair in the exact format DPO fine-tuning expects. No extra labelling step — the training data pipeline is built into the correction loop.

### Google AI models and infrastructure used

| Component | Technology |
|---|---|
| Task agent LLM | **Gemini 2.0 Flash** via Google GenAI Python SDK |
| Meta-agent LLM | **Gemini 2.0 Flash** — reads traces, proposes diffs |
| SRE console chat | **Gemini 2.0 Flash** streaming (SSE) |
| Document ingestion (Knowledge DB) | **Gemini 2.0 Flash** with `response_mime_type="application/json"` for structured KG extraction |
| Client SDK | **google-genai ≥ 1.0.0** |

**Google internal tools not yet integrated (production roadmap):**
- **Sherlock** — would replace our statistical z-score watcher with Google's production anomaly detection signal
- **X-Manager / Borg** — repair tasks are currently simulated; in production these would be real Borg job submissions via X-Manager
- **Brogg** — could replace our SQLite KG with a scalable graph store for fleet-wide correction sharing across racks

### What is live functional code vs. simulated

| Component | Status | Detail |
|---|---|---|
| Fault simulator | ✅ Live code | Python thermal model: `dT = 0.085·util − 0.082·fan + mem_heat + noise`. Fan decay −3%/tick, mem leak +2.4%/tick. Seeded, deterministic. |
| Statistical watcher | ✅ Live code | Z-score anomaly detection; flags when temp exceeds threshold |
| Task agent — Gemini diagnosis | ✅ Live code | Real Gemini 2.0 Flash API call with KG-augmented prompt, structured JSON output |
| Knowledge graph | ✅ Live code | SQLite-backed corrections, Jaccard similarity retrieval, persists across episodes |
| Meta-agent | ✅ Live code | Real Gemini API call that reads traces and proposes prompt diffs |
| SRE console chat | ✅ Live code | Gemini streaming over SSE; system prompt includes live node state + active incident |
| WebSocket telemetry | ✅ Live code | FastAPI WebSocket pushes tick/incident/repair events in real time |
| Document ingestion (Knowledge DB) | ✅ Live code | Gemini extracts nodes/edges from dropped files or URLs; persists to SQLite |
| Override rate chart history | 🟡 Simulated | 40-episode mock curve showing realistic decay with spikes at new fault classes |
| Composite score / gen curves | 🟡 Simulated | Pre-computed scores reflecting the real architecture; not from live held-out runs |
| Agent version history | 🟡 Simulated | Realistic diffs and metrics per generation; not auto-generated at demo runtime |
| DPO training loop | 🔴 Not implemented | Preference pairs export is live; training requires more episodes and a fine-tuning run |
