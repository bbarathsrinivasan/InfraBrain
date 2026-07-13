# Metrics & the Learning Loop

This is the heart of InfraBrain: **what we measure, and how each metric feeds back to improve the system.** Nothing here is cosmetic — every metric is either a training signal, a gate, or a reward term.

---

## 0. The mental model

InfraBrain improves along three independent loops that operate on different timescales and change different things. A metric only matters if it drives one of these loops.

```
  INCIDENT ──► agent suggests ──► SRE Accept / Override ──► outcome measured
      ▲                                    │                        │
      │                                    ▼                        ▼
      │                          (1) KG correction written   (3) episode trace
      │                              [seconds→minutes]            archived
      │                                    │                        │
      └───── retrieval on next incident ◄──┘                        ▼
                                                       (2) meta-agent rewrites
                                                           task-agent code
                                                              [offline]
```

- **Loop 1 — Retrieval (per incident, seconds):** the agent queries the KG for corrections matching the current symptom signature. Weights are frozen; only the *context* the agent reasons over changes.
- **Loop 2 — Memory (per override, minutes):** an SRE override writes a permanent correction record to the KG. This is non-parametric learning — the KG grows, nothing is retrained.
- **Loop 3 — Evolution (per generation, offline):** a meta-agent reads a batch of episode traces and rewrites the task-agent's *code* (retrieval strategy, prompt, ranking). Kept only if it improves the held-out score.

---

## 1. The metrics we track

### 1.1 Override rate — the headline metric
**Definition:** fraction of incidents where the SRE rejected the agent's suggested action.

`override_rate = overrides / total_incidents` over a rolling window of episodes.

**Why it's the north star:** it is a *pure human-agreement signal* with no labels required. Every override is simultaneously (a) an error the agent made, and (b) a fresh, correctly-labeled training example. As the KG accumulates corrections, matching incidents retrieve the right answer and the override rate falls. A falling override rate on *new seeds of the same scenario family* is the cleanest evidence that institutional memory is working.

**Where it appears:** Learning Lab → "Override rate ↓".

### 1.2 Composite score — the meta-agent's objective
The scalar the meta-agent optimizes. It's a weighted sum of four terms (Learning Lab → "Composite reward decomposition"):

| Term | Weight | What it rewards |
|------|--------|-----------------|
| **diagnosis correct** | 0.40 | did the agent name the true root cause? |
| **MTTR** | 0.25 | time-to-recovery — fewer ticks from detection to resolved |
| **override penalty** | 0.20 | penalizes suggestions the SRE had to reject |
| **safety** | 0.15 | penalizes dangerous actions (e.g. draining a healthy node) |

`composite = 0.40·correct + 0.25·mttr_score + 0.20·(1−override) + 0.15·safety`

**Why this shape:** correctness alone lets an agent be right slowly and unsafely. Folding MTTR, override penalty, and safety into one scalar means the meta-agent can't game one dimension. This *same* composite becomes the reward function for GRPO later (see §3) — the metric and the future RL signal are identical by design.

### 1.3 Train vs. held-out composite — the generalization gate
We split fault scenarios into **train** and **held-out** families. The meta-agent only ever sees train traces; held-out is scored but never used to select variants.

**Why it's the honesty check:** a rising *train* score can just be memorization. A rising *held-out* score means the rewritten agent generalizes to faults it has never seen. **We report improvement as the held-out number** (0.55 → 0.61 for gen-3→gen-4). Any variant that improves train but regresses held-out is rejected.

**Where it appears:** Learning Lab → "Composite score ↑" (two lines) and "Generalization by scenario family".

### 1.4 Retrieval hit-rate — is the KG actually helping?
**Definition:** fraction of incidents where the KG returned a correction whose signature matched the current one.

`hit_rate = incidents_with_matching_correction / incidents_with_a_relevant_correction`

**Why:** it isolates Loop 1 from Loop 3. If hit-rate is high but override rate isn't falling, the retrieval is finding records but the agent is ignoring them (a prompt/ranking bug — a job for the meta-agent). It climbs as corrections accumulate. Shown in Knowledge Graph → "KG stats".

### 1.5 MTTR (mean time to recovery)
Ticks from watcher-detection to `resolved`. Drops from ~6.8 (gen-0) to ~3.1 (gen-4) because the right action is chosen first, avoiding a wrong-fix-then-refix cycle. Shown live in the Observability fleet-health strip.

### 1.6 Preference-pair yield
Count of `(context, rejected, chosen)` triples exported. Every override yields exactly one. This is the raw material for DPO (§3). Shown in Training Data.

---

## 2. How each metric updates the system

This is the "how we use the metrics" part — the mapping from **metric → concrete change**.

### 2.1 Override → KG correction (Loop 2, non-parametric)
When an SRE overrides, we write a structured record:

```json
{
  "signature": "temp↑/fan↓ @ R2-N5",
  "rejected":  "throttle_job",
  "applied":   "ramp_fans",
  "context":   "gen-4, util falling while temp rising",
  "source":    "operator_override"
}
```

- The **KG grows by one correction node** (amber in the graph). No model is retrained.
- On the **next** incident, retrieval surfaces this record and ranks it above seed knowledge. The agent's prompt now contains "a human previously rejected `throttle_job` here and applied `ramp_fans`."
- Effect: **override rate falls, retrieval hit-rate rises.** This is the fast loop — a lesson learned once, applied forever, and deletable if it turns out to be wrong (no un-training required).

### 2.2 Episode traces → meta-agent code rewrite (Loop 3, evolution)
After a batch of episodes, the meta-agent receives the traces plus the aggregate metrics. It proposes a **code diff** to the task agent. Example — the actual gen-3→gen-4 change (Learning Lab → "Show gen-3→4 diff"):

```diff
-    # Exact label match only
-    hits = kg.query(label=symptom.label)
+    # Gen-3 traces: 6/9 misses were near-miss sigs.
+    # Similarity retrieval; rank corrections first.
+    hits = kg.query_similar(symptom.signature, k=5)
+    hits.sort(key=lambda h:(h.kind!="correction", h.age))
```

The meta-agent *read the failure metric* (6 of 9 misses were near-miss signatures that exact-label lookup skipped) and rewrote the retrieval function to fix that class of error.

- The new variant runs on the **train** split; its **held-out composite** is measured.
- **Gate:** kept only if held-out improves (0.55 → 0.61). Otherwise archived as rejected (kept for lineage, never selected as a parent). See the variant archive.
- Parent selection for the next generation is by **score × exploration** — high scorers are favored, but exploration bonus keeps the search from collapsing onto one lineage.

### 2.3 Preference pairs → model fine-tuning (Loop 3b, future — §3)
The exported pairs are DPO-ready. This is the only loop that touches model *weights*, and it's future work — see below.

---

## 3. From metrics to model updates (the roadmap)

We are honest that RL/DPO are **not yet implemented** — two days isn't enough episodes for stable RL, and preference pairs are the honest bridge. The architecture, however, is already shaped so that turning them on requires no new metrics.

**Phase 02 (this demo): suggest-only with SREs.**
Agent suggests, SRE decides, overrides write to the KG and export preference pairs. Override rate is the live health metric.

**Phase 03a — DPO on preference pairs.**
Fine-tune a small policy (3–8B, LoRA) directly on the accumulated `(context, rejected, chosen)` pairs. No reward model needed — DPO learns from the preference directly. **Gate:** held-out composite must not regress. The metric that gates DPO is the *same* held-out composite that gates the meta-agent today.

**Phase 03b — GRPO against the simulator.**
The fault-injection simulator **is** the RL environment: it emits the composite reward (§1.2) for any trajectory. GRPO optimizes the policy against that reward directly. Nothing new to build — the reward function is already the composite score we display, and the simulator already produces episodes on demand.

**Why this ordering:** KG memory + meta-agent evolution give a working closed loop *today* with zero training risk. DPO adds parametric learning once enough pairs exist. GRPO adds full RL once DPO has warm-started a competent policy. Each step reuses the metrics defined above rather than inventing new ones.

---

## 4. Summary table — metric → loop → update

| Metric | Feeds loop | Concrete update it drives |
|--------|-----------|---------------------------|
| Override rate | Memory (2) | writes KG correction; north-star health signal |
| Retrieval hit-rate | Retrieval (1) | validates KG lookup; flags prompt/ranking bugs for meta-agent |
| Composite score | Evolution (3) | meta-agent's objective; future GRPO reward |
| Train vs held-out | Evolution (3) | **gate** — accept/reject each code variant |
| MTTR | Evolution (3) | reward term; live operations KPI |
| Preference-pair yield | Fine-tuning (3b) | DPO training data |
