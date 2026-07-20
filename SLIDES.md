# InfraBrain: A Self-Improving Agent That Learns from Every Override

**5-minute presentation · 3 parts · 6 slides**

---

## Title Slide

**InfraBrain**
*A Self-Improving Agent That Learns from Every Override*

---

## Part 1 — The Problem

### Slide 1 · The Question

> **"How many of you have seen an AI system make the same mistake twice?"**

That's the problem. When an AI diagnostic agent gets a fault wrong, a human corrects it — and the agent learns nothing. The next identical fault gets misdiagnosed again.

- Fault fires → agent misreads a deceptive signal → applies the wrong fix
- Human overrides → correct fix applied → **the correction vanishes**
- 6.0 min resolution instead of 4.7 min — every time

---

### Slide 2 · Scale of Impact

> **"What if every correction your team makes could teach the agent permanently?"**

- **30%** of faults misdiagnosed at baseline *(real Gemini 3.5 Flash data)*
- **1.3 min** wasted per fault on wrong fixes
- **0** corrections retained — today's agents are stateless

The deeper problem: it's not accuracy, it's that the signal is wasted.

---

## Part 2 — Solution & Demo

### Slide 3 · Three Learning Loops

InfraBrain closes the loop — three ways:

1. **KG Retrieval** *(seconds)* — past corrections surface at alert time, ranked first
2. **KG Corrections** *(minutes)* — every operator override is written back permanently
3. **Meta-Agent Rewrite + Eval Gate** *(offline)* — meta-agent rewrites the task agent's code; `infrabrain-eval` runs 120 live API calls to block regressions before they ship

> **"We'll see this in action — live demo."**

---

### Slide 4 · Demo

*[Live demo of the InfraBrain app]*

- Node hits WARN threshold → agent suggests action
- Operator overrides → KG graph updates in real time
- Composite score chart shows real Gemini results across 6 generations

**Key moment to point out:** gen-1 jump (30% → 5% override from a single correction) and the gen-5 regression caught by the eval gate before deployment.

---

## Part 3 — Why It's Novel

### Slide 5 · Three Novel Contributions

> **"Three things here that don't exist together anywhere else."**

**01 · KG-Grounded Live Memory**
Corrections are indexed and retrieved at runtime — the KG grows with every override.
Unlike RAG over static docs, this memory updates in production.
*→ Lewis et al. 2020, Retrieval-Augmented Generation (Meta AI / NeurIPS)*

**02 · Meta-Agent Rewrites the Task Agent**
The meta-agent analyzes correction patterns and generates a code diff.
The eval gate validates it with real API calls — gen-5's regression was caught here.
*→ Darwin Gödel Machine, arXiv 2503.19461*

**03 · Preference Pairs → Model Fine-Tuning**
Every override produces a (rejected → accepted) pair stored in SQLite.
Ready for DPO fine-tuning — directly usable by model teams or to fine-tune Gemma.
*→ Rafailov et al. 2023, Direct Preference Optimization (Stanford)*

---

### Closing · The Flywheel

> **"Here's why this compounds."**

```
Better Agents  →  Better Preference Data  →  Better Models (Gemma)  →  Better Agents
```

We improve the agents. That improvement generates training signal. Better models make better agents. The loop closes itself.

> **"Any questions?"**

---

## Talk Track Notes

| Part | Time | Slide |
|------|------|-------|
| Title | 15s | 1 |
| Problem question + flow | 30s | 2 |
| Scale / stats | 30s | 3 |
| Solution overview | 45s | 4 |
| Live demo | 90s | 5 |
| Three novel parts | 60s | 6 |
| Flywheel close | 15s | 6 |
| **Total** | **~5 min** | |
