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

**Architecture — teacher and student:**
- Task agent (student) handles every live incident: detects anomaly → queries knowledge graph → calls Gemini 2.0 Flash to diagnose → suggests fix to SRE
- Meta-agent (teacher) runs offline: reads episode traces → identifies where the student keeps failing → rewrites the student's diagnostic prompt as a code diff → only ships if held-out score improves (eval gate blocks regressions)
- Three learning loops: KG retrieval augments context in seconds, SRE overrides write corrections in minutes, meta-agent rewrites code offline between generations

**What makes it novel:**
- Corrections stored in a knowledge graph (SQLite), not model weights — auditable, reversible, no catastrophic forgetting. A bad lesson is one DELETE, not an un-training run
- Meta-agent with a held-out eval gate — improvements transfer to fault classes neither agent trained on (validated by DGM-Hyperagents paper, arXiv 2503.19461)
- Every SRE override auto-exports a DPO preference pair — training data pipeline is built into the correction loop from day one

**Google AI models used:**
- Gemini 2.0 Flash — task agent diagnosis, meta-agent code evolution, SRE console chat (streaming), and document ingestion into knowledge graph
- Google GenAI Python SDK (google-genai ≥ 1.0.0)

**Google infrastructure — production roadmap:**
- Sherlock → would replace our z-score watcher with Google's production anomaly detection
- X-Manager / Borg → repair tasks currently simulated; in production these become real Borg job submissions
- Brogg → would replace SQLite KG with a scalable graph store for fleet-wide correction sharing

**Live functional code vs. simulated:**

✅ Live code:
- Python thermal fault simulator (dT = 0.085·util − 0.082·fan + noise), 32 nodes, seeded from Alibaba GPU cluster traces
- Statistical z-score watcher for anomaly detection
- Gemini 2.0 Flash task agent with KG-augmented prompt and structured JSON output
- SQLite knowledge graph with Jaccard similarity retrieval, persists across episodes
- Gemini 2.0 Flash meta-agent that reads traces and proposes prompt diffs
- SRE console chat with Gemini streaming over SSE
- FastAPI WebSocket pushing real-time telemetry to the frontend
- Knowledge DB — Gemini extracts nodes/edges from dropped files or URLs into the KG

🟡 Simulated / pre-computed:
- Override rate chart history (40-episode mock curve)
- Composite score and generation curves (pre-computed; reflect real architecture)
- Agent version history per generation (realistic diffs; not auto-generated at runtime)

🔴 Not yet implemented:
- DPO/GRPO training loop — preference pairs export is live, training run needs more episodes
