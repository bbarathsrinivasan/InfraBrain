# InfraBrain: A Self-Improving Agent That Learns from Every Override

**5-minute presentation · 3 parts · 7 slides**

---

## Title Slide

**InfraBrain**
*A Self-Improving Agent That Learns from Every Override*

---

## Part 1 — The Problem

### Slide 1 · The Question

> **"How many of you have seen an AI system make the same mistake twice?"**

That's the problem. We're talking about server infrastructure — nodes throwing hardware alerts: a fan spinning down, a CPU thermal throttling, memory pressure spiking. An AI diagnostic agent reads the telemetry and recommends a remediation action — ramp the fans, throttle the job, migrate the workload. When it picks the wrong action, an SRE corrects it. And the agent learns nothing. The next identical fault, on the next identical node, gets misdiagnosed again.

- Fault fires → agent misreads a deceptive signal → applies the wrong fix
- Human overrides → correct fix applied → **the correction vanishes**
- Result: slower resolution and wasted human time, every time

---

### Slide 2 · Scale of Impact

> **"What if every correction your team makes could teach the agent permanently?"**

**The cost of getting it wrong:**
- **$14,056/min** — average cost of unplanned infrastructure downtime *(EMA Research, 2024)* [¹](#ref1)
- **31%** of AI agent production failures come from wrong tool or action choice *(2024–25 enterprise deployments)* [²](#ref2)
- **40%** MTTR reduction is achievable when AI automation is correct — but most teams never get there *(Rootly, 2025)* [³](#ref3)

**What InfraBrain measured with real Gemini API calls:**
- **30%** of faults misdiagnosed at baseline with no KG context *(120 Gemini 3.5 Flash calls, infrabrain-eval)* [⁴](#ref4)
- **1.3 min** wasted per fault — 6.0 min avg vs 4.7 min with correct diagnosis *(infrabrain-eval simulator)* [⁴](#ref4)
- **0** corrections retained — today's agents are stateless; the override signal is lost

---

## Part 2 — Solution & Demo

### Slide 3 · Three Learning Loops

InfraBrain closes the loop — three ways:

1. **KG Retrieval** *(seconds)* — past corrections surface at alert time, ranked first
2. **KG Corrections** *(minutes)* — every operator override is written back permanently
3. **Meta-Agent Rewrite + Eval Gate** *(offline)* — meta-agent rewrites the task agent's code; `infrabrain-eval` runs 120 live Gemini API calls to block regressions before they ship

> **"We'll see this in action — live demo."**

---

### Slide 4 · Demo

*[Live demo of the InfraBrain app]*

- Node hits WARN threshold → agent suggests action
- Operator overrides → KG graph updates in real time
- Composite score chart shows real Gemini results across 6 generations

**Key moment to point out:** gen-1 jump (30% → 5% override from a single correction) and the gen-5 regression caught by the eval gate before deployment.

---

### Slide 5 · Darwin Gödel Machine — The Paper

> *"This isn't just an idea we had — it's grounded in a 2025 paper from Sakana AI and Google DeepMind."*

**Darwin Gödel Machine** — arXiv 2503.19461  
*Sakana AI · Google DeepMind · University of British Columbia, 2025*

Core idea: an agent that iteratively rewrites its own code, validated by an empirical eval gate before each new version ships.

**How InfraBrain maps to it:**

| Paper concept | InfraBrain implementation |
|---|---|
| Meta-agent | `POST /api/meta` (InfraBrain backend) |
| Code diff / rewrite | Task-agent prompt rewrite from KG patterns |
| Eval gate | `infrabrain-eval` (120 live Gemini API calls) |
| Block regression | Gen-5 CRITICAL NOTE caught before deploy |

*→ Add paper cover image to this slide before the talk*

---

## Part 3 — Why It's Novel

### Slide 6 · Three Novel Contributions

> **"Three things here that don't exist together anywhere else."**

**01 · KG-Grounded Live Memory**
Corrections are indexed and retrieved at runtime — the KG grows with every override.
Unlike RAG over static docs, this memory updates in production.
*→ Lewis et al. 2020, Retrieval-Augmented Generation — Meta AI / NeurIPS* [⁵](#ref5)

**02 · Meta-Agent Rewrites the Task Agent**
The meta-agent analyzes correction patterns and generates a code diff.
The eval gate validates it with real API calls — gen-5's regression was caught here.
*→ Darwin Gödel Machine, arXiv 2503.19461* [⁶](#ref6)

**03 · Preference Pairs → Model Fine-Tuning**
Every override produces a (rejected → accepted) pair stored in SQLite.
Ready for DPO fine-tuning — directly usable by model teams or to fine-tune Gemma.
*→ Rafailov et al. 2023, Direct Preference Optimization — Stanford* [⁷](#ref7)

---

### Slide 7 · The Flywheel

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
| Solution overview | 30s | 4 |
| Live demo | 75s | 4 |
| Darwin Gödel Machine paper | 20s | 5 |
| Three novel parts | 60s | 6 |
| Flywheel close | 15s | 7 |
| **Total** | **~5 min** | |

---

## References

<a name="ref1">¹</a> EMA Research (2024) — *The True Costs of Downtime in 2025*
https://www.erwoodgroup.com/blog/the-true-costs-of-downtime-in-2025-a-deep-dive-by-business-size-and-industry/

<a name="ref2">²</a> Trantornic (2024–25) — *AI Agent Failure Modes: What Goes Wrong in Production*
https://www.trantorinc.com/blog/ai-agent-failure-modes-what-goes-wrong-design-resilience

<a name="ref3">³</a> Rootly (2025) — *AI Incident Automation Cuts MTTR by 40%*
https://rootly.com/sre/2025-devops-trend-ai-incident-automation-cuts-mttr-40

<a name="ref4">⁴</a> infrabrain-eval — *Real LLM Evaluation Results (120 Gemini 3.5 Flash API calls)*
https://github.com/bbarathsrinivasan/InfraBrain/blob/master/infrabrain-eval/REPORT_LLM.md

<a name="ref5">⁵</a> Lewis et al. 2020 — *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*
https://arxiv.org/abs/2005.11401

<a name="ref6">⁶</a> Sakana AI / Google DeepMind (2025) — *The AI Scientist / Darwin Gödel Machine*
https://arxiv.org/abs/2503.19461

<a name="ref7">⁷</a> Rafailov et al. 2023 — *Direct Preference Optimization: Your Language Model is Secretly a Reward Model*
https://arxiv.org/abs/2305.18290
