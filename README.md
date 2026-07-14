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

## Setup & run

### Prerequisites

- **Node.js 18+** (frontend)
- **Python 3.10+** (backend)
- **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey) (for live LLM mode)

### 1. Clone and install

```bash
git clone <repo-url>
cd infrabrain

# Frontend
npm install

# Backend
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

### 2. Configure environment

**Backend** — copy and edit:

```bash
cp backend/.env.example backend/.env
```

```env
# backend/.env
GEMINI_API_KEY=your-key-here
PORT=8002
# USE_SCRIPTED_AGENT=true   # optional — force scripted agent (no API calls)
```

**Frontend** — copy and edit (needed for full-stack mode):

```bash
cp .env.example .env
```

```env
# .env (project root)
VITE_BACKEND_WS=ws://localhost:8002/api/stream
VITE_BACKEND_HTTP=http://localhost:8002
```

Leave root `.env` empty or remove `VITE_BACKEND_*` to run **demo mode** (in-browser simulator + scripted agent, no backend).

> **Note:** `.env` files are gitignored. Never commit API keys.

### 3. Start the backend

```bash
cd backend
source venv/bin/activate
python main.py
# → FastAPI on http://localhost:8002
#   WebSocket: ws://localhost:8002/api/stream
```

Or without auto-reload:

```bash
uvicorn main:app --host 0.0.0.0 --port 8002
```

### 4. Start the frontend

In a second terminal, from the project root:

```bash
npm run dev
# → http://localhost:5175
```

### 5. Verify connection

Open the frontend. The status badge in the top-right shows:

| Badge | Meaning |
|-------|---------|
| `demo mode` | No backend `.env` — in-browser sim only |
| `connecting…` | Backend URL set, waiting for WebSocket |
| `backend ●` (green) | Live backend connected |

**Quick health checks:**

```bash
curl http://localhost:8002/api/metrics
curl http://localhost:8002/api/kg
```

### 6. Try the demo flow

1. Click **▶ Gen-0 episode**, then **▶ RUN**
2. Faults fire at **t010** (R2-N5 fan) and **t022** (R3-N2 memory)
3. Gen-0 misdiagnoses fan failure as CPU overload → accept, then watch auto-override teach the KG
4. Click **▶ Gen-4 replay** — agent uses KG corrections and gets fan failure right
5. Open **Learning Lab** → **Run meta-agent** to see a live code-diff proposal from episode traces
6. **Knowledge Graph** tab → **↺ Reset KG** clears corrections (seed taxonomy preserved)

---

## Demo mode vs. backend mode

| Feature | Demo mode (no `.env`) | Backend mode |
|---------|----------------------|--------------|
| Simulator | In-browser JS | Python `step_nodes()`, authoritative |
| Diagnosis | Scripted `buildSuggestion()` | Gemini (`gemini-flash-latest`) + KG context |
| SRE chat | Scripted `askAgent()` | Gemini streaming via `/api/chat` |
| KG corrections | React state (resets on refresh) | SQLite, persists across episodes |
| Meta-agent | Static diff string | Live `POST /api/meta` from traces |
| Metrics / Learning Lab | Static charts | Live `/api/metrics` polling |

Set `USE_SCRIPTED_AGENT=true` in `backend/.env` to run the full backend stack without Gemini API calls (scripted diagnosis + chat + meta-agent).

---

## What is real vs. simulated/hardcoded

Use this table when explaining the demo to judges.

| Component | Status | Detail |
|-----------|--------|--------|
| **Fault simulator** | ✅ Real (Python) | Thermal model `dT = 0.085·util − 0.082·fan + mem_heat + noise`; fan decay −3%/tick; mem leak +2.4%/tick. Seeded, deterministic. |
| **Watcher** | ✅ Real | Temp threshold in backend; inline check in frontend demo mode. |
| **Task Agent (diagnosis)** | ✅ Real (Gemini API) | `gemini-flash-latest`, KG-augmented prompt, structured JSON. Scripted fallback if key missing or `USE_SCRIPTED_AGENT=true`. |
| **Knowledge Graph** | ✅ Real (SQLite) | Corrections persist across episodes. Jaccard similarity retrieval. `backend/kg.py`. |
| **Meta-Agent** | ✅ Real (Gemini API) | Reads episode traces, proposes unified diff. `POST /api/meta`. |
| **SRE Console chat** | ✅ Real (Gemini streaming) | SSE streaming; system prompt includes node state + incident + KG corrections. |
| **WebSocket telemetry** | ✅ Real | Backend pushes tick/incident/repair events; frontend reconnects on drop. |
| **Override rate chart** | 🟡 Mixed | Demo curve when traces sparse; live overrides update KG + metrics. |
| **Composite score / gen curves** | 🟡 Static mock | `GEN_DATA` in JSX for full gen-0→5 arc; live metrics overlay where available. |
| **Agent version history** | 🟡 Realistic mock | `src/versions/gen{0-5}.json` — real diffs and metrics, not auto-generated at runtime. |
| **DPO / GRPO training** | 🔴 Future scope | Preference pairs export is live. Training loop not implemented. |

---

## API surface (backend)

| Method | Path | Purpose |
|--------|------|---------|
| WS | `/api/stream` | Live telemetry, incidents, repairs, KG updates |
| POST | `/api/chat` | Streaming SRE console (SSE) |
| GET | `/api/kg` | Corrections, pairs, traces snapshot |
| GET | `/api/kg/retrieve?sig=...` | Top-k similarity retrieval |
| POST | `/api/kg/reset` | Clear corrections, pairs, traces |
| GET | `/api/metrics` | Override rate, MTTR, composite, reward terms |
| POST | `/api/meta` | Run meta-agent on episode traces |
| GET | `/api/state` | Current simulator snapshot |

See [docs/BACKEND.md](docs/BACKEND.md) for architecture details.

---

## Three-phase production deployment

**Phase 01 — Shadow mode**
Seed KG from postmortems and playbooks. Run in shadow mode against fault-injection tooling — accumulate corrections before touching live SREs.

**Phase 02 — Suggest-only with SREs** ← *This demo is Phase 02*
Agent suggests, SRE decides. Every override writes a correction to the KG and exports a preference pair. Override rate falls as KG grows.

**Phase 03 — DPO / GRPO training**
Finetune a small model via DPO on accumulated preference pairs. GRPO against the simulator's composite reward is the next step.

---

## Key design decisions

- **Suggest-only.** The agent never remediates autonomously — an SRE Accepts or Overrides.
- **Non-parametric memory.** Corrections live in a knowledge graph, not model weights.
- **Deceptive symptom by design.** Fan failure → thermal throttling → util *drops* → gen-0 misdiagnoses as CPU idle.
- **Held-out eval gate.** Meta-agent proposals only accepted if held-out composite improves.

---

## Docs

- **[docs/METRICS_AND_LEARNING.md](docs/METRICS_AND_LEARNING.md)** — composite reward formula, metric → update mapping
- **[docs/BACKEND.md](docs/BACKEND.md)** — API surface, KG schema, meta-agent design

## Reference

Hyperagents (arXiv 2603.19461) — DGM-Hyperagents: task agent + meta agent in one editable program; archive of variants, parents selected by score × exploration, train/held-out split for generalisation.
