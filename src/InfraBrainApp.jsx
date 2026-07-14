import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend, ReferenceLine } from "recharts";

/* ── DESIGN TOKENS ───────────────────────────────────────────────────── */
const T = {
  bg:"#111214", panel:"#1A1D21", soft:"#21252C", line:"#2E333D",
  text:"#D8DDE8", muted:"#7A8599", faint:"#434B5C",
  ok:"#4CC38A", warn:"#F0B429", crit:"#EF5350",
  agent:"#8FA0FF", kg:"#FFB74D",
};
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/* ── STATIC DUMMY DATA ───────────────────────────────────────────────── */
const OVERRIDE_DATA = [
  // Gen-0 baseline: high and noisy
  {ep:1,rate:78},{ep:2,rate:74},{ep:3,rate:76},{ep:4,rate:71},
  // Spike at ep5: NIC-flap fault class introduced — agent has no prior knowledge
  {ep:5,rate:83},{ep:6,rate:79},{ep:7,rate:73},{ep:8,rate:68},
  // KG corrections accumulating → slow decline
  {ep:9,rate:64},{ep:10,rate:61},{ep:11,rate:66},{ep:12,rate:58},
  // Spike at ep13: power-droop class — new scenario, zero KG coverage
  {ep:13,rate:72},{ep:14,rate:65},{ep:15,rate:59},{ep:16,rate:53},
  // Gen-2: correction-first ranking — faster retrieval of known patterns
  {ep:17,rate:48},{ep:18,rate:44},{ep:19,rate:51},{ep:20,rate:42},
  // Gen-3: Jaccard similarity — near-miss signatures now retrievable
  {ep:21,rate:38},{ep:22,rate:35},{ep:23,rate:41},{ep:24,rate:33},
  // Gen-4: k=5 + contradiction-check — KG evidence actually used
  {ep:25,rate:29},{ep:26,rate:25},{ep:27,rate:31},{ep:28,rate:23},
  // Gen-5: deception-aware diagnostic note — fan-failure class fixed
  {ep:29,rate:22},{ep:30,rate:19},{ep:31,rate:24},{ep:32,rate:17},
  {ep:33,rate:21},{ep:34,rate:16},{ep:35,rate:20},{ep:36,rate:14},
  {ep:37,rate:18},{ep:38,rate:15},{ep:39,rate:19},{ep:40,rate:14},
];
const GEN_DATA = [
  {gen:0,train:0.31,holdout:0.28},{gen:1,train:0.42,holdout:0.36},
  {gen:2,train:0.51,holdout:0.44},{gen:3,train:0.58,holdout:0.55},
  {gen:4,train:0.66,holdout:0.61},{gen:5,train:0.71,holdout:0.64},
];
const META_DIFF = `--- agents/gen3/diagnose.py
+++ agents/gen4/diagnose.py
@@ meta agent · gen-4 · held-out 0.55 → 0.61

-    # Exact label match only
-    hits = kg.query(label=symptom.label)
+    # Gen-3 traces: 6/9 misses were near-miss sigs.
+    # Similarity retrieval; rank corrections first.
+    hits = kg.query_similar(symptom.signature, k=5)
+    hits.sort(key=lambda h:(h.kind!="correction",h.age))

-    prompt += f"Telemetry: {window.summary()}"
+    prompt += f"Telemetry: {window.summary()}"
+    prompt += f"\\nKG corrections: {fmt(hits)}"
+    prompt += "\\nIf a correction contradicts your"
+    prompt += " hypothesis, explain why before deciding."`;

// Dense KG seeded from real failure taxonomies:
// OPT-175B logbook, BLOOM/Llama-3 training logs (466 interruptions/54 days),
// Alibaba GPU Cluster Trace, Microsoft Philly traces
// → https://github.com/alibaba/clusterdata  (Alibaba trace)
// → https://github.com/facebookresearch/opt_metaseq/blob/main/projects/OPT/chronicles/OPT175B_Logbook.pdf
const KG_NODES = [
  // Symptoms (left column) — from real failure corpora
  {id:"s1", label:"temp spike",     kind:"symptom", x:42, y:28 },
  {id:"s2", label:"util drop",      kind:"symptom", x:42, y:72 },
  {id:"s3", label:"fan% fall",      kind:"symptom", x:42, y:116},
  {id:"s4", label:"dark node",      kind:"symptom", x:42, y:160},
  {id:"s5", label:"mem monotonic↑", kind:"symptom", x:42, y:204},
  {id:"s6", label:"NIC flap",       kind:"symptom", x:42, y:248},
  {id:"s7", label:"power droop",    kind:"symptom", x:42, y:292},
  {id:"s8", label:"NCCL hang",      kind:"symptom", x:42, y:336},
  {id:"s9", label:"ECC errors↑",    kind:"symptom", x:42, y:380},
  {id:"s10",label:"job eviction",   kind:"symptom", x:42, y:424},
  // Causes (middle column)
  {id:"c1", label:"fan failure",    kind:"cause",   x:195, y:28 },
  {id:"c2", label:"cpu overload",   kind:"cause",   x:195, y:82 },
  {id:"c3", label:"mem leak",       kind:"cause",   x:195, y:136},
  {id:"c4", label:"node dead",      kind:"cause",   x:195, y:190},
  {id:"c5", label:"NIC hw fault",   kind:"cause",   x:195, y:244},
  {id:"c6", label:"PSU droop",      kind:"cause",   x:195, y:298},
  {id:"c7", label:"NCCL deadlock",  kind:"cause",   x:195, y:352},
  {id:"c8", label:"thermal cascade",kind:"cause",   x:195, y:406},
  // Actions (right column)
  {id:"a1", label:"ramp_fans",      kind:"action",  x:348, y:28 },
  {id:"a2", label:"throttle_job",   kind:"action",  x:348, y:96 },
  {id:"a3", label:"migrate_wkld",   kind:"action",  x:348, y:164},
  {id:"a4", label:"drain_node",     kind:"action",  x:348, y:232},
  {id:"a5", label:"restart_node",   kind:"action",  x:348, y:300},
  {id:"a6", label:"escalate",       kind:"action",  x:348, y:368},
  {id:"a7", label:"ckpt_restart",   kind:"action",  x:348, y:436},
];
const KG_SEED_EDGES = [
  // Symptom → Cause (from real failure taxonomy)
  ["s1","c1"],["s1","c2"],["s1","c8"],
  ["s2","c2"],["s2","c8"],   // util drop = either overload throttle or thermal cascade
  ["s3","c1"],               // fan fall → fan failure (leading indicator)
  ["s4","c4"],               // dark node → hardware dead
  ["s5","c3"],               // monotonic mem → mem leak
  ["s6","c5"],               // NIC flap → NIC hardware fault
  ["s7","c6"],               // power droop → PSU issue
  ["s8","c7"],["s8","c5"],   // NCCL hang → deadlock or NIC fault (both in OPT logbook)
  ["s9","c1"],["s9","c8"],   // ECC errors → fan failure (thermal) or cascade
  ["s10","c4"],["s10","c6"], // job eviction → dead node or PSU droop
  // Cause → Action
  ["c1","a1"],["c1","a4"],   // fan failure → ramp or drain (escalate if severe)
  ["c2","a2"],               // overload → throttle
  ["c3","a3"],["c3","a5"],   // mem leak → migrate or restart
  ["c4","a4"],["c4","a6"],   // dead → drain + escalate
  ["c5","a4"],["c5","a6"],   // NIC fault → drain + escalate
  ["c6","a4"],["c6","a6"],   // PSU → drain + escalate
  ["c7","a7"],["c7","a5"],   // NCCL deadlock → checkpoint restart or restart
  ["c8","a1"],["c8","a4"],   // thermal cascade → ramp fans first, drain if unrecovered
];
const ACTIONS = ["ramp_fans","throttle_job","migrate_workload","drain_node","restart_node","escalate","no_action"];

/* Multiple fault sources → multiple concurrent incidents */
const FAULTS = [
  {node:"R2-N5", type:"fan", start:10},
  {node:"R3-N2", type:"mem", start:22},
];
const FAULT_NODE = "R2-N5"; // hero scenario

/* Blast radius: co-scheduled workloads per node (static demo data) */
function blastRadius(nodeId){
  const [r,n] = nodeId.replace("R","").split("-N");
  const base = 1000 + (+r)*8 + (+n);
  return {
    primary:`job-${base}(trace)`,
    shards:[`shard-${base}-a`,`shard-${base}-b`,`shard-${base}-c`],
    replica:`R${(+r%4)+1}-N1 (checkpoint replica)`,
    tenant: (+r%2? "team-vision" : "team-nlp"),
  };
}
const RUNBOOKS = {
  fan:["Confirm fan RPM decline on telemetry", "Ramp fans → 90% (ramp_fans)",
       "Verify temp slope reverses within 4 ticks", "No recovery → drain_node + RMA fan"],
  mem:["Capture heap snapshot on node", "Migrate workload to healthy peer (migrate_workload)",
       "Restart affected process (restart_node)", "Confirm mem plateaus post-restart"],
  default:["Inspect telemetry window", "Query KG for matching signature", "Escalate if signature is novel"],
};
const SLASH_COMMANDS = [
  {cmd:"/diagnose",  desc:"re-run diagnosis on focused node", kind:"query"},
  {cmd:"/explain",   desc:"explain the agent's current reasoning", kind:"query"},
  {cmd:"/history",   desc:"show KG corrections for this signature", kind:"query"},
  {cmd:"/status",    desc:"fleet health summary", kind:"query"},
  {cmd:"/ramp_fans", desc:"queue ramp_fans repair on focused node", kind:"action", action:"ramp_fans"},
  {cmd:"/throttle",  desc:"queue throttle_job repair", kind:"action", action:"throttle_job"},
  {cmd:"/migrate",   desc:"queue migrate_workload repair", kind:"action", action:"migrate_workload"},
  {cmd:"/drain",     desc:"drain the focused node", kind:"action", action:"drain_node"},
  {cmd:"/restart",   desc:"restart the focused node", kind:"action", action:"restart_node"},
  {cmd:"/borg",      desc:"launch a raw Borg repair job", kind:"borg"},
  {cmd:"/escalate",  desc:"escalate focused incident to on-call", kind:"escalate"},
];

/* Per-scenario-family generalization (train vs held-out) */
const SCENARIO_FAMILIES = [
  {family:"fan degradation", train:0.71, holdout:0.66, n:120},
  {family:"memory leak",     train:0.64, holdout:0.58, n:96 },
  {family:"power droop",     train:0.59, holdout:0.52, n:74 },
  {family:"NIC flap",        train:0.55, holdout:0.49, n:61 },
];
/* Hyperagents variant archive — parent selection by score × exploration */
const ARCHIVE = [
  {gen:"0",  parent:"—",  holdout:0.28, status:"seed"},
  {gen:"1",  parent:"g0", holdout:0.36, status:"kept"},
  {gen:"2",  parent:"g1", holdout:0.44, status:"kept"},
  {gen:"3",  parent:"g2", holdout:0.55, status:"kept"},
  {gen:"3b", parent:"g2", holdout:0.51, status:"rejected"},
  {gen:"4",  parent:"g3", holdout:0.61, status:"kept"},
  {gen:"4b", parent:"g3", holdout:0.57, status:"rejected"},
  {gen:"5",  parent:"g4", holdout:0.64, status:"kept"},
];
/* Composite reward decomposition */
const REWARD_TERMS = [
  {term:"diagnosis correct",  w:0.40, val:0.86},
  {term:"MTTR (speed)",       w:0.25, val:0.71},
  {term:"override penalty",   w:0.20, val:0.63},
  {term:"safety (no bad act)",w:0.15, val:0.94},
];
/* KG retrieval trace for the focused signature (top-k) */
const RETRIEVAL_TRACE = [
  {sig:"temp↑/fan↓ @ R2-N5", sim:0.94, kind:"correction", note:"exact-family match — ranked #1"},
  {sig:"temp↑/fan↓ @ R1-N3", sim:0.88, kind:"correction", note:"near-miss, same fault type"},
  {sig:"fan↓ steady-state",  sim:0.61, kind:"seed",       note:"fan-failure seed rule"},
  {sig:"temp↑/util↑",        sim:0.42, kind:"seed",       note:"cpu-overload seed — down-ranked"},
];
/* Training-data source mix */
const DATA_MIX = [
  {src:"simulator episodes", n:237, color:T.agent},
  {src:"seeded postmortems", n:64,  color:T.ok},
  {src:"operator overrides", n:"live", color:T.kg},
];
/* Real-world failure datasets (grounding / the "data hub") */
const DATA_SOURCES = [
  {name:"Alibaba GPU Cluster Trace", use:"workload replay", live:true,
   note:"6.5k+ GPUs · job + resource traces · drives realistic training load"},
  {name:"Microsoft Philly Traces", use:"failure patterns", live:false,
   note:"DNN-training cluster · job failures, retries, queue delays"},
  {name:"Meta OPT-175B Logbook", use:"failure taxonomy", live:false,
   note:"chronicle of 100+ hardware faults/restarts during pretraining"},
  {name:"BLOOM / Llama-3 training logs", use:"failure taxonomy", live:false,
   note:"GPU failures, NCCL hangs, ckpt restarts · Llama-3: 466 interruptions / 54-day run"},
  {name:"Google Borg cluster traces", use:"scheduler behavior", live:false,
   note:"task evictions + machine failures at datacenter scale"},
];

/* Agent versions — one entry per generation · imported from src/versions/*.json */
const AGENT_VERSIONS = [
  { gen:0, status:"baseline", holdout:0.28, overrideRate:0.76, mttr:9.2,
    retrievalStrategy:"exact-label match only",
    promptVersion:"v0.1",
    keyChange:"Baseline. No KG integration. Exact-label lookup only — misses all near-miss signatures.",
    metaDiff:null,
    knownFailures:["Fan failure → CPU overload misdiagnosis (thermal throttle deception)","No cross-rack near-miss retrieval","Zero correction awareness"],
  },
  { gen:1, status:"kept", holdout:0.36, overrideRate:0.64, mttr:7.8,
    retrievalStrategy:"exact-label + 1-hop KG neighbors",
    promptVersion:"v0.3",
    keyChange:"Added 1-hop KG neighbor traversal. Captures adjacent fault patterns. Corrections still not prioritised.",
    metaDiff:"- hits = kg.query(label=symptom.label)\n+ hits = kg.query_neighbors(symptom.label, depth=1)",
    knownFailures:["Cross-rack near-miss still invisible","Correction nodes not ranked above seeds"],
  },
  { gen:2, status:"kept", holdout:0.44, overrideRate:0.51, mttr:6.4,
    retrievalStrategy:"1-hop neighbors + correction-first ranking",
    promptVersion:"v0.6",
    keyChange:"Corrections now ranked above seed rules. First real use of operator knowledge in retrieval path.",
    metaDiff:"  hits = kg.query_neighbors(symptom.label, depth=1)\n+ hits.sort(key=lambda h: h.kind != 'correction')",
    knownFailures:["Similarity retrieval not yet implemented","Fan deception still unaddressed"],
  },
  { gen:3, status:"kept", holdout:0.55, overrideRate:0.38, mttr:4.9,
    retrievalStrategy:"Jaccard similarity k=3, corrections first, age-weighted",
    promptVersion:"v0.9",
    keyChange:"First true similarity retrieval (Jaccard token overlap). Near-miss signatures from other racks now retrievable.",
    metaDiff:"- hits = kg.query_neighbors(symptom.label, depth=1)\n+ hits = kg.query_similar(symptom.signature, k=3)\n+ hits.sort(key=lambda h: (h.kind != 'correction', h.age))",
    knownFailures:["k=3 occasionally misses 4th-most-relevant correction","Thermal throttle deception still not in prompt"],
  },
  { gen:"3b", status:"rejected", holdout:0.51, overrideRate:0.43, mttr:5.2,
    retrievalStrategy:"BM25 scoring k=3",
    promptVersion:"v0.8b",
    keyChange:"Tried BM25 scoring instead of Jaccard — worse calibration on short symptom signatures. Rejected.",
    metaDiff:"- hits = kg.query_similar(symptom.signature, k=3)  # Jaccard\n+ hits = kg.bm25_query(symptom.signature, k=3)  # BM25",
    knownFailures:["BM25 over-weights rare tokens in short sigs","Held-out 0.51 < parent 0.55 — rejected"],
  },
  { gen:4, status:"kept", holdout:0.61, overrideRate:0.26, mttr:3.8,
    retrievalStrategy:"Jaccard similarity k=5, corrections first + contradiction check",
    promptVersion:"v1.2",
    keyChange:"k raised to 5. Agent must explicitly explain if a KG correction contradicts its hypothesis before deciding.",
    metaDiff:"- hits = kg.query_similar(symptom.signature, k=3)\n+ hits = kg.query_similar(symptom.signature, k=5)\n \n- prompt += f'KG entries: {fmt(hits)}'\n+ prompt += f'KG corrections: {fmt(hits)}'\n+ prompt += '\\nIf a correction contradicts your hypothesis, explain why before deciding.'",
    knownFailures:["Thermal throttle deception occasionally causes fan↓+util↓ = CPU idle misread"],
  },
  { gen:"4b", status:"rejected", holdout:0.57, overrideRate:0.31, mttr:4.1,
    retrievalStrategy:"k=5 + chain-of-thought prefix",
    promptVersion:"v1.1b",
    keyChange:"Added chain-of-thought prefix (Let me think step-by-step…) — reduced confidence calibration, worse composite. Rejected.",
    metaDiff:"+ prompt = 'Let me think step-by-step.\\n' + prompt",
    knownFailures:["CoT prefix inflated verbosity, degraded conf calibration","Held-out 0.57 < parent 0.61 — rejected"],
  },
  { gen:5, status:"current", holdout:0.64, overrideRate:0.17, mttr:3.1,
    retrievalStrategy:"Jaccard k=5, corrections first + deception-aware diagnostic note",
    promptVersion:"v1.5",
    keyChange:"Added explicit CRITICAL DIAGNOSTIC NOTE: fan↓+temp↑ while util↓ = thermal throttling, NOT cpu idle. Decisive fix for fan-failure class.",
    metaDiff:"+ CRITICAL DIAGNOSTIC NOTE:\n+   Fan failure: fan↓ sustained + temp↑ while util FALLS (thermal throttle — deceptive!)\n+   CPU overload: util↑ sustained + temp↑, fan STABLE\n+   Memory leak:  mem↑ monotonic + temp rising + util flat",
    knownFailures:[],
  },
];

/* ── SIMULATOR ───────────────────────────────────────────────────────── */
function freshNodes() {
  const out = [];
  for (let r=1; r<=4; r++)
    for (let n=1; n<=8; n++)
      out.push({id:`R${r}-N${n}`, temp:56+Math.random()*10, util:52+Math.random()*28,
        fan:55+Math.random()*12, mem:34+Math.random()*16,
        job:`job-${1000+r*8+n}(trace)`, status:"ok"});
  return out;
}
const statusOf = t => t>=88?"crit":t>=75?"warn":"ok";
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const faultAt = id => FAULTS.find(f=>f.node===id);

function stepNodes(nodes, t, repairs) {
  return nodes.map(nd => {
    let {temp,util,fan,mem} = nd;
    const f = faultAt(nd.id);
    const rep = repairs.find(r=>r.node===nd.id && r.effectApplied);
    util = clamp(util+(Math.random()-.49)*4, 20, 98);
    mem  = clamp(mem+(Math.random()-.5)*1.5, 20, 99);
    // fault dynamics
    if (f && t>=f.start && !rep) {
      if (f.type==="fan") fan = Math.max(14, fan-3.0);
      if (f.type==="mem") mem = Math.min(99, mem+2.4);
    }
    // repair effects
    if (rep) {
      if (rep.action==="ramp_fans")        fan  = Math.min(96, fan+9);
      if (rep.action==="throttle_job")     util = Math.max(25, util-12);
      if (rep.action==="migrate_workload"){util = Math.max(20, util-18); mem = Math.max(25, mem-14);}
      if (rep.action==="drain_node")       util = Math.max(5,  util-22);
      if (rep.action==="restart_node")     mem  = Math.max(24, mem-16);
    }
    if (temp>=88) util *= 0.93;                 // thermal throttling — deceptive symptom
    const memHeat = mem>82 ? (mem-82)*0.12 : 0; // mem pressure adds heat
    const dT = 0.085*util - 0.082*fan - 0.45 + memHeat + (Math.random()-.5)*0.7;
    temp = clamp(temp+dT, 45, 104);
    return {...nd, temp, util, fan, mem, status:statusOf(temp)};
  });
}

/* ── SHARED UI ───────────────────────────────────────────────────────── */
function Chip({label, value, color=T.text}) {
  return <div style={{background:T.panel,border:`1px solid ${T.line}`,borderRadius:6,
    padding:"4px 9px",fontFamily:MONO,fontSize:11}}>
    <span style={{color:T.faint}}>{label} </span><span style={{color}}>{value}</span>
  </div>;
}
function Panel({title, sub, children, dashed, style, right, fillHeight}) {
  return <div style={{background:T.panel,border:`1px solid ${dashed?T.faint:T.line}`,
    borderStyle:dashed?"dashed":"solid",borderRadius:10,padding:12,
    ...(fillHeight?{display:"flex",flexDirection:"column",minHeight:0}:{}),
    ...style}}>
    {(title||right) && <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:sub?2:0}}>
      {title && <div style={{fontSize:12.5,fontWeight:600}}>{title}</div>}
      <div style={{flex:1}}/>{right}
    </div>}
    {sub   && <div style={{fontFamily:MONO,fontSize:10,color:T.muted,marginBottom:8}}>{sub}</div>}
    {fillHeight
      ? <div style={{flex:1,minHeight:0,overflowY:"auto"}}>{children}</div>
      : children}
  </div>;
}
function Btn({children, color=T.agent, onClick, disabled, style}) {
  return <button onClick={onClick} disabled={disabled} style={{background:"transparent",
    border:`1px solid ${color}`,color,borderRadius:6,padding:"5px 11px",fontSize:11,
    fontFamily:MONO,cursor:disabled?"default":"pointer",opacity:disabled?.45:1,...style}}>
    {children}
  </button>;
}
function Dot({color}) {
  return <span style={{display:"inline-block",width:7,height:7,borderRadius:4,
    background:color,marginRight:3}}/>;
}

/* ── STATUS BAR ──────────────────────────────────────────────────────── */
function StatusBar({tick,running,agentGen,episodes,corrections,onRun,onGen0,onGen4,chatOpen,onChatToggle}) {
  return <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
    <div style={{fontFamily:MONO,fontSize:18,fontWeight:700,letterSpacing:4}}>
      INFRA<span style={{color:T.agent}}>BRAIN</span>
    </div>
    <Chip label="t" value={String(tick).padStart(3,"0")}/>
    <Chip label="agent" value={`gen-${agentGen}`} color={T.agent}/>
    <Chip label="episodes" value={episodes}/>
    <Chip label="corrections" value={corrections} color={T.kg}/>
    <div style={{flex:1}}/>
    <Btn color={T.muted} onClick={onGen0}>▶ Gen-0 episode</Btn>
    <Btn color={T.agent} onClick={onGen4}>▶ Gen-4 replay</Btn>
    <Btn color={running?T.warn:T.ok} onClick={onRun} style={{minWidth:80}}>
      {running?"❚❚ PAUSE":"▶ RUN"}
    </Btn>
    {/* SRE Console toggle — opens floating chat panel, zero screen space when closed */}
    <button onClick={onChatToggle} style={{
      background:chatOpen?T.agent+"22":"transparent",
      border:`1px solid ${chatOpen?T.agent:T.line}`,
      color:chatOpen?T.agent:T.muted,
      borderRadius:6,padding:"5px 12px",fontSize:11,fontFamily:MONO,
      cursor:"pointer",display:"flex",alignItems:"center",gap:6,
    }}>
      <span style={{fontSize:13}}>💬</span> SRE Console
    </button>
  </div>;
}

/* ── TAB BAR ─────────────────────────────────────────────────────────── */
const TABS = ["Overview","Observability","Knowledge Graph","Learning Lab","Training Data"];
const TAB_HINTS = {
  "Overview":         "system architecture — three self-improving loops · meta-agent evolves task-agent code offline",
  "Observability":    "real-time fleet view — watch fault develop, agent suggest, override teach the system",
  "Knowledge Graph":  "non-parametric memory — amber nodes are operator corrections · drop docs to evolve the graph",
  "Learning Lab":     "agent evolution — 6 generations of incremental prompt + retrieval improvements on held-out scenarios",
  "Training Data":    "future scope — preference pairs ready for DPO · simulator ready for GRPO",
};
function TabBar({active, onSelect}) {
  return <div style={{display:"flex",flexDirection:"column",gap:6}}>
    <div style={{display:"flex",gap:2,background:T.soft,borderRadius:10,padding:4}}>
      {TABS.map(t => <button key={t} onClick={()=>onSelect(t)} style={{
        background:active===t?T.panel:"transparent",
        border:active===t?`1px solid ${T.line}`:"1px solid transparent",
        color:active===t?T.text:T.muted,
        borderRadius:6,padding:"5px 14px",fontSize:12,fontFamily:MONO,cursor:"pointer",
      }}>{t}</button>)}
    </div>
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,paddingLeft:4}}>{TAB_HINTS[active]}</div>
  </div>;
}

/* ── FLEET HEALTH STRIP ──────────────────────────────────────────────── */
function HealthStat({label, value, color=T.text}) {
  return <div style={{display:"flex",flexDirection:"column",gap:1,minWidth:78}}>
    <span style={{fontFamily:MONO,fontSize:20,fontWeight:700,color}}>{value}</span>
    <span style={{fontFamily:MONO,fontSize:9.5,color:T.faint,letterSpacing:1}}>{label}</span>
  </div>;
}
function FleetHealthStrip({nodes, incidents, repairs, mttr}) {
  const ok  = nodes.filter(n=>n.status==="ok").length;
  const wn  = nodes.filter(n=>n.status==="warn").length;
  const cr  = nodes.filter(n=>n.status==="crit").length;
  const active = incidents.filter(i=>i.stage!=="resolved").length;
  const inFlight = repairs.length;
  const hottest = nodes.reduce((a,b)=>b.temp>a.temp?b:a, nodes[0]);
  const mttrVal = typeof mttr === "number" ? mttr.toFixed(1) : (mttr || "6.8");
  return <Panel style={{padding:"10px 14px"}}>
    <div style={{display:"flex",alignItems:"center",gap:22,flexWrap:"wrap"}}>
      <HealthStat label="HEALTHY" value={ok} color={T.ok}/>
      <HealthStat label="DEPLETING" value={wn} color={T.warn}/>
      <HealthStat label="CRITICAL" value={cr} color={T.crit}/>
      <div style={{width:1,height:34,background:T.line}}/>
      <HealthStat label="ACTIVE INCIDENTS" value={active} color={active?T.crit:T.muted}/>
      <HealthStat label="RT JOBS IN FLIGHT" value={inFlight} color={inFlight?T.agent:T.muted}/>
      <HealthStat label="MTTR (ticks)" value={mttrVal} color={T.text}/>
      <div style={{flex:1}}/>
      <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,textAlign:"right"}}>
        <div>hottest node</div>
        <div style={{color:hottest?.temp>=88?T.crit:hottest?.temp>=75?T.warn:T.ok}}>
          {hottest?.id} · {hottest?.temp.toFixed(1)}°C</div>
      </div>
    </div>
  </Panel>;
}

/* ── FOCUS SWITCHER (shared across incidents/telemetry/events) ───────── */
function FocusSwitcher({incidents, focusNode, onFocus}) {
  const active = incidents.filter(i=>i.stage!=="resolved");
  const stageColor = {analyzing:T.warn, suggested:T.agent, repairing:T.agent, monitoring:T.warn, resolved:T.ok};
  return <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
    <span style={{fontFamily:MONO,fontSize:10,color:T.faint,letterSpacing:1}}>FOCUS</span>
    {active.length===0 &&
      <span style={{fontFamily:MONO,fontSize:11,color:T.faint}}>no active incidents — click a node to inspect</span>}
    {active.map(inc => {
      const isSel = inc.node===focusNode;
      return <button key={inc.id} onClick={()=>onFocus(inc.node)} style={{
        background:isSel?T.soft:"transparent", border:`1px solid ${isSel?stageColor[inc.stage]:T.line}`,
        borderRadius:16, padding:"4px 11px", fontFamily:MONO, fontSize:11, cursor:"pointer",
        color:isSel?T.text:T.muted, display:"flex", alignItems:"center", gap:6}}>
        <Dot color={stageColor[inc.stage]}/>{inc.node}
        <span style={{color:T.faint}}>· {inc.stage}</span>
      </button>;
    })}
  </div>;
}

/* ── RACK GRID ───────────────────────────────────────────────────────── */
function RackGrid({nodes, selected, repairs, onSelect}) {
  const colOf = st => st==="crit"?T.crit:st==="warn"?T.warn:T.ok;
  const repairSet = new Set(repairs.filter(r=>!r.effectApplied).map(r=>r.node));
  return <Panel title="Fleet — 4 racks × 8 nodes" sub="GPU training nodes · Alibaba trace-replay workload">
    {[1,2,3,4].map(r => <div key={r} style={{marginBottom:8}}>
      <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginBottom:3}}>RACK {r}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:4}}>
        {nodes.filter(n=>n.id.startsWith(`R${r}-`)).map(n => {
          const col=colOf(n.status), isSel=n.id===selected;
          const repairing=repairSet.has(n.id);
          return <button key={n.id} onClick={()=>onSelect(n.id)}
            title={`${n.id} · ${n.temp.toFixed(1)}°C`}
            style={{height:32,borderRadius:4,cursor:"pointer",position:"relative",
              background:col+"22",border:`1px solid ${isSel?T.agent:col}`,
              outline:isSel?`1px solid ${T.agent}`:"none"}}>
            {repairing && <span style={{position:"absolute",top:-5,right:-3,fontSize:7,
              background:T.agent,color:T.bg,borderRadius:3,padding:"0 3px",fontFamily:MONO}}>RT</span>}
          </button>;
        })}
      </div>
    </div>)}
    <div style={{fontFamily:MONO,fontSize:10,color:T.muted,marginTop:4,display:"flex",gap:12,flexWrap:"wrap"}}>
      <span><Dot color={T.ok}/>healthy</span>
      <span><Dot color={T.warn}/>depleting</span>
      <span><Dot color={T.crit}/>critical</span>
      <span style={{color:T.agent}}>RT</span><span> = repair task</span>
    </div>
  </Panel>;
}

/* ── REPAIR TASK QUEUE ───────────────────────────────────────────────── */
function RepairQueue({repairs, onCancel, style, fillHeight}) {
  return <Panel title="Repair task queue" sub="Borg-style RT jobs · suggest-only: queued by SRE, never autonomous" style={style} fillHeight={fillHeight}>
    {repairs.length===0 && <div style={{fontFamily:MONO,fontSize:11,color:T.faint}}>
      No repair tasks in flight. Accept an incident or use /borg to queue one.
    </div>}
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      {repairs.map(r => {
        const done=r.effectApplied;
        return <div key={r.taskId} style={{display:"flex",alignItems:"center",gap:8,
          border:`1px solid ${T.line}`,borderRadius:6,padding:"5px 8px",fontFamily:MONO,fontSize:10.5}}>
          <span style={{color:T.agent}}>{r.taskId}</span>
          <span style={{color:T.faint}}>{r.node}</span>
          <span style={{color:T.text}}>{r.action}</span>
          <div style={{flex:1}}/>
          {done
            ? <span style={{color:T.ok}}>✓ applied · monitoring</span>
            : <span style={{color:T.warn}}>▶ {r.ticksLeft} ticks</span>}
          {!done && <Btn color={T.faint} onClick={()=>onCancel(r.taskId)} style={{padding:"1px 6px"}}>✕</Btn>}
        </div>;
      })}
    </div>
  </Panel>;
}

/* ── TELEMETRY ───────────────────────────────────────────────────────── */
function Strip({data, dataKey, color, label, domain, refs=[]}) {
  return <div style={{marginBottom:4}}>
    <div style={{fontFamily:MONO,fontSize:9.5,color:T.faint,marginBottom:1}}>{label}</div>
    <ResponsiveContainer width="100%" height={66}>
      <LineChart data={data} margin={{top:4,right:6,bottom:0,left:-26}}>
        <XAxis dataKey="t" hide/>
        <YAxis domain={domain} tick={{fill:T.faint,fontSize:9}} stroke={T.line}/>
        {refs.map(v=><ReferenceLine key={v} y={v} stroke={v>=88?T.crit:T.warn}
          strokeDasharray="4 3" strokeOpacity={.6}/>)}
        <Line dataKey={dataKey} stroke={color} dot={false} strokeWidth={1.8} isAnimationActive={false}/>
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
function Telemetry({history, nodes, selected}) {
  const nd=nodes.find(n=>n.id===selected);
  const data=history[selected]||[];
  return <Panel title={`Telemetry — ${selected}`}
    sub={nd?`${nd.temp.toFixed(1)}°C · util ${nd.util.toFixed(0)}% · fan ${nd.fan.toFixed(0)}% · mem ${nd.mem.toFixed(0)}% · ${nd.job}`:"select a node"}>
    <Strip data={data} dataKey="temp" color={T.crit} label="temperature °C — warn 75° · crit 88°" domain={[45,105]} refs={[75,88]}/>
    <Strip data={data} dataKey="util" color={T.ok}   label="GPU utilization %" domain={[0,100]}/>
    <Strip data={data} dataKey="fan"  color={T.agent} label="fan speed %" domain={[0,100]}/>
    <Strip data={data} dataKey="mem"  color={T.kg}   label="memory % — warn 82%" domain={[0,100]} refs={[82]}/>
  </Panel>;
}

/* ── INCIDENT TIMELINE STEPPER ───────────────────────────────────────── */
const STAGES = ["analyzing","suggested","repairing","monitoring","resolved"];
const STAGE_SHORT = {analyzing:"detect",suggested:"suggest",repairing:"repair",monitoring:"monitor",resolved:"resolved"};
function IncidentTimeline({stage}) {
  const cur = STAGES.indexOf(stage);
  return <div style={{display:"flex",alignItems:"center",gap:0}}>
    {STAGES.map((s,i)=>{
      const done=i<cur, active=i===cur;
      const col = done?T.ok:active?T.agent:T.faint;
      return <div key={s} style={{display:"flex",alignItems:"center",flex:i<STAGES.length-1?1:0}}>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
          <div style={{width:11,height:11,borderRadius:6,background:active?col:"transparent",
            border:`2px solid ${col}`}}/>
          <span style={{fontFamily:MONO,fontSize:8.5,color:col}}>{STAGE_SHORT[s]}</span>
        </div>
        {i<STAGES.length-1 && <div style={{flex:1,height:2,background:done?T.ok:T.line,margin:"0 3px 12px"}}/>}
      </div>;
    })}
  </div>;
}

/* ── INCIDENT PANEL ──────────────────────────────────────────────────── */
function IncidentPanel({incident, agentGen, onAccept, onOverride, onEscalate, style, fillHeight}) {
  const [picking,setPicking] = useState(false);
  const s=incident?.suggestion, stage=incident?.stage;
  const stageLabel = {
    analyzing:"Task agent analyzing…", suggested:"Awaiting SRE decision",
    repairing:"Repair task executing", monitoring:"Post-fix monitoring — time-to-recurrence",
    resolved:"Resolved",
  };
  return <Panel title={incident?`Incident — ${incident.node}`:"Incident"}
    sub={stage?stageLabel[stage]:"Watcher quiet — no anomaly on focused node"}
    right={incident && <Btn color={T.crit} onClick={()=>onEscalate(incident)} style={{padding:"3px 9px"}}>⚑ Escalate</Btn>}
    style={style} fillHeight={fillHeight}>
    {!incident && <div style={{fontSize:11.5,color:T.faint,fontFamily:MONO}}>
      Faults fire at t010 (R2-N5 fan) and t022 (R3-N2 mem).<br/>
      Gen-0 misdiagnoses fan as CPU overload.<br/>Gen-4 gets it right via KG correction.
    </div>}
    {incident && <div style={{marginBottom:10}}><IncidentTimeline stage={stage}/></div>}
    {stage==="analyzing" && <div style={{fontFamily:MONO,fontSize:11.5,color:T.warn}}>
      Anomaly flagged — querying telemetry + KG…
    </div>}
    {s && <div>
      <div style={{fontSize:13.5,fontWeight:600,color:T.agent,marginBottom:4}}>{s.diagnosis}</div>
      <div style={{fontFamily:MONO,fontSize:11,marginBottom:8}}>
        <span style={{color:T.muted}}>suggested: </span>{s.action}
        <span style={{color:T.muted}}> · conf </span>{s.conf}
        {s.overridden && <span style={{color:T.kg}}> · OVERRIDDEN → {s.chosenAction}</span>}
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontFamily:MONO,fontSize:9.5,letterSpacing:1,color:T.faint,marginBottom:4}}>
          CITED EVIDENCE — why the agent made this call
        </div>
        {s.evidence.map((e,i) => <div key={i} style={{
          borderLeft:`2px solid ${e.startsWith("KG")?T.kg:T.line}`,
          paddingLeft:7,marginBottom:4,fontSize:11,
          color:e.startsWith("KG")?T.kg:T.muted,fontFamily:MONO}}>{e}</div>)}
      </div>
      {stage==="suggested" && !picking && <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <Btn color={T.ok} onClick={()=>onAccept(incident)}>Accept & queue repair</Btn>
        <Btn color={T.kg} onClick={()=>setPicking(true)}>Override…</Btn>
      </div>}
      {stage==="suggested" && picking && <div>
        <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginBottom:5}}>
          SELECT CORRECT ACTION — writes correction to KG + exports pair
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {ACTIONS.filter(a=>a!==s.action).map(a =>
            <Btn key={a} color={T.kg} onClick={()=>{setPicking(false);onOverride(incident,a);}}>{a}</Btn>)}
          <Btn color={T.faint} onClick={()=>setPicking(false)}>cancel</Btn>
        </div>
      </div>}
      {stage==="repairing"  && <div style={{fontFamily:MONO,fontSize:11,color:T.agent}}>Borg-style repair task executing — 4 ticks…</div>}
      {stage==="monitoring" && <div style={{fontFamily:MONO,fontSize:11,color:T.warn}}>Monitoring post-fix window — measuring time-to-recurrence…</div>}
      {stage==="resolved"   && <div style={{fontFamily:MONO,fontSize:11,color:T.ok}}>
        ✓ Resolved — node stable. {agentGen>=4?"Zero overrides. KG retrieval worked.":"Try Gen-4 replay to compare."}
      </div>}
    </div>}
  </Panel>;
}

/* ── BLAST RADIUS + RUNBOOK ──────────────────────────────────────────── */
function BlastRunbook({incident, style, fillHeight}) {
  if(!incident) return <Panel title="Blast radius & runbook" sub="focus an incident to see impact + playbook" style={style} fillHeight={fillHeight}>
    <div style={{fontFamily:MONO,fontSize:11,color:T.faint}}>No incident focused.</div>
  </Panel>;
  const b = blastRadius(incident.node);
  const rb = RUNBOOKS[incident.faultType] || RUNBOOKS.default;
  return <Panel title="Blast radius & runbook" sub={`impact of ${incident.node} · tenant ${b.tenant}`} style={style} fillHeight={fillHeight}>
    <div style={{fontFamily:MONO,fontSize:10.5,lineHeight:1.8,marginBottom:8}}>
      <div><span style={{color:T.faint}}>primary job </span><span style={{color:T.crit}}>{b.primary}</span></div>
      <div><span style={{color:T.faint}}>co-scheduled </span><span style={{color:T.warn}}>{b.shards.join(" · ")}</span></div>
      <div><span style={{color:T.faint}}>replica </span><span style={{color:T.ok}}>{b.replica}</span></div>
    </div>
    <div style={{fontFamily:MONO,fontSize:9.5,letterSpacing:1,color:T.faint,marginBottom:4}}>
      RUNBOOK — {incident.faultType} fault
    </div>
    <div style={{fontFamily:MONO,fontSize:10.5,lineHeight:1.7}}>
      {rb.map((step,i)=><div key={i} style={{color:T.muted}}>
        <span style={{color:T.agent}}>{i+1}.</span> {step}</div>)}
    </div>
  </Panel>;
}

/* ── EVENT LOG ───────────────────────────────────────────────────────── */
function EventLog({log, focusNode, style, fillHeight}) {
  const col = {sys:T.muted, watch:T.warn, agent:T.agent, op:T.kg};
  const lbl = {sys:"SYS  ", watch:"WATCH", agent:"AGENT", op:"SRE  "};
  const shown = focusNode ? log.filter(e=>!e.node || e.node===focusNode) : log;
  return <Panel title="Event log" sub={focusNode?`filtered → ${focusNode} · watcher · agent · SRE`:"watcher · task agent · SRE operator"} style={style} fillHeight={fillHeight}>
    <div style={{fontFamily:MONO,fontSize:10.5,lineHeight:1.7}}>
      {shown.map((e,i) => <div key={i} style={{color:col[e.kind]||T.muted,display:"flex",gap:6}}>
        <span style={{color:T.faint,minWidth:30}}>t{String(e.t).padStart(3,"0")}</span>
        <span style={{color:T.faint,minWidth:44}}>[{lbl[e.kind]||"SYS  "}]</span>
        <span>{e.text}</span>
      </div>)}
    </div>
  </Panel>;
}

/* ── SRE CHAT + SLASH COMMAND PALETTE ────────────────────────────────── */
function SREChat({messages, onSend, focusNode}) {
  const [val,setVal] = useState("");
  const [sel,setSel] = useState(0);
  const scrollRef = useRef(null);
  const showPalette = val.startsWith("/");
  const filtered = SLASH_COMMANDS.filter(c=>c.cmd.startsWith(val.split(" ")[0]));
  useEffect(()=>{ if(scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; },[messages]);
  useEffect(()=>{ setSel(0); },[val]);

  function submit(cmdText){
    const text = (cmdText ?? val).trim();
    if(!text) return;
    onSend(text);
    setVal("");
  }
  function onKey(e){
    if(showPalette && filtered.length){
      if(e.key==="ArrowDown"){e.preventDefault();setSel(s=>(s+1)%filtered.length);return;}
      if(e.key==="ArrowUp"){e.preventDefault();setSel(s=>(s-1+filtered.length)%filtered.length);return;}
      if(e.key==="Tab"){e.preventDefault();setVal(filtered[sel].cmd+" ");return;}
    }
    if(e.key==="Enter"){e.preventDefault();submit();}
  }
  const roleColor = {sre:T.kg, agent:T.agent, sys:T.muted};
  const roleLabel = {sre:"SRE",agent:"AGENT",sys:"SYS"};
  return <Panel title="SRE console" sub={`ask the agent · type "/" for actions · focus ${focusNode||"—"}`} style={{flex:1,display:"flex",flexDirection:"column"}}>
    <div ref={scrollRef} style={{flex:1,minHeight:120,maxHeight:230,overflowY:"auto",
      fontFamily:MONO,fontSize:11,lineHeight:1.6,marginBottom:8}}>
      {messages.map((m,i)=><div key={i} style={{marginBottom:6}}>
        <span style={{color:roleColor[m.role]||T.muted,fontSize:9.5}}>{roleLabel[m.role]||"SYS"} </span>
        <span style={{color:m.role==="sre"?T.text:roleColor[m.role]||T.muted,whiteSpace:"pre-wrap"}}>{m.text}</span>
      </div>)}
    </div>
    <div style={{position:"relative"}}>
      {showPalette && filtered.length>0 && <div style={{position:"absolute",bottom:"100%",left:0,right:0,
        background:T.soft,border:`1px solid ${T.line}`,borderRadius:8,marginBottom:4,maxHeight:180,
        overflowY:"auto",boxShadow:"0 -4px 16px rgba(0,0,0,.4)"}}>
        {filtered.map((c,i)=><div key={c.cmd} onMouseDown={e=>{e.preventDefault();setVal(c.cmd+" ");}}
          style={{display:"flex",gap:8,padding:"5px 9px",cursor:"pointer",
            background:i===sel?T.panel:"transparent",fontFamily:MONO,fontSize:10.5}}>
          <span style={{color:c.kind==="action"||c.kind==="borg"?T.agent:c.kind==="escalate"?T.crit:T.kg,minWidth:82}}>{c.cmd}</span>
          <span style={{color:T.muted}}>{c.desc}</span>
        </div>)}
      </div>}
      <div style={{display:"flex",gap:6}}>
        <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={onKey}
          placeholder='Ask the agent, or "/" for actions…'
          style={{flex:1,background:T.bg,border:`1px solid ${T.line}`,borderRadius:6,
            color:T.text,fontFamily:MONO,fontSize:11,padding:"7px 9px",outline:"none"}}/>
        <Btn color={T.agent} onClick={()=>submit()}>send</Btn>
      </div>
    </div>
  </Panel>;
}

/* ── OBSERVABILITY TAB ───────────────────────────────────────────────── */
function ObservabilityTab(p) {
  const focusIncident = p.incidents.find(i=>i.node===p.focusNode && i.stage!=="resolved")
                     || p.incidents.find(i=>i.node===p.focusNode);
  /* Fixed viewport height: 100vh minus navbar(~42) + tabbar(~56) + margins(~48) + footer(~28) + padding(28) = 202px */
  return <div style={{display:"flex",flexDirection:"column",gap:12,
    height:"calc(100vh - 202px)",overflow:"hidden"}}>
    <FleetHealthStrip nodes={p.nodes} incidents={p.incidents} repairs={p.repairs} mttr={p.mttr}/>
    <FocusSwitcher incidents={p.incidents} focusNode={p.focusNode} onFocus={p.onSelect}/>
    {/* Grid takes all remaining space */}
    <div style={{display:"grid",gridTemplateColumns:"290px 1fr 350px",gap:12,
      flex:1,minHeight:0,overflow:"hidden"}}>
      {/* Left: rack (fixed) + repair queue (fills) */}
      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0,overflow:"hidden"}}>
        <RackGrid nodes={p.nodes} selected={p.focusNode} repairs={p.repairs} onSelect={p.onSelect}/>
        <RepairQueue repairs={p.repairs} onCancel={p.onCancelRepair}
          style={{flex:1,minHeight:0}} fillHeight/>
      </div>
      {/* Center: telemetry (fixed) + blast radius (fills) */}
      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0,overflow:"hidden"}}>
        <Telemetry history={p.history} nodes={p.nodes} selected={p.focusNode}/>
        <BlastRunbook incident={focusIncident} style={{flex:1,minHeight:0}} fillHeight/>
      </div>
      {/* Right: incident (fills) + event log (fills) */}
      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0,overflow:"hidden"}}>
        <IncidentPanel incident={focusIncident} agentGen={p.agentGen}
          onAccept={p.onAccept} onOverride={p.onOverride} onEscalate={p.onEscalate}
          style={{flex:1,minHeight:0}} fillHeight/>
        <EventLog log={p.log} focusNode={p.focusNode}
          style={{flex:1,minHeight:0}} fillHeight/>
      </div>
    </div>
  </div>;
}

/* ── SHARED: METER ROW ───────────────────────────────────────────────── */
function MeterRow({label, value, max=1, color=T.agent, right}) {
  const pct = Math.max(0,Math.min(100,(value/max)*100));
  return <div style={{marginBottom:7}}>
    <div style={{display:"flex",fontFamily:MONO,fontSize:10.5,marginBottom:2}}>
      <span style={{color:T.muted}}>{label}</span><div style={{flex:1}}/>
      <span style={{color}}>{right ?? value}</span>
    </div>
    <div style={{height:6,background:T.soft,borderRadius:3,overflow:"hidden"}}>
      <div style={{width:pct+"%",height:"100%",background:color,borderRadius:3}}/>
    </div>
  </div>;
}

/* ── LEARNING: PER-FAMILY GENERALIZATION ─────────────────────────────── */
function ScenarioFamilyPanel() {
  return <Panel title="Generalization by scenario family"
    sub="held-out score per fault type · proves the agent transfers across fault classes, not one trick">
    {SCENARIO_FAMILIES.map(f => <div key={f.family} style={{marginBottom:9}}>
      <div style={{display:"flex",fontFamily:MONO,fontSize:10.5,marginBottom:3}}>
        <span style={{color:T.text}}>{f.family}</span>
        <span style={{color:T.faint,marginLeft:6}}>· n={f.n}</span>
        <div style={{flex:1}}/>
        <span style={{color:T.agent}}>train {f.train}</span>
        <span style={{color:T.ok,marginLeft:8}}>held {f.holdout}</span>
      </div>
      <div style={{position:"relative",height:8,background:T.soft,borderRadius:4}}>
        <div style={{position:"absolute",width:f.train*100+"%",height:"100%",background:T.agent,opacity:.35,borderRadius:4}}/>
        <div style={{position:"absolute",width:f.holdout*100+"%",height:"100%",background:T.ok,borderRadius:4}}/>
      </div>
    </div>)}
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginTop:2}}>
      solid = held-out · faded = train. Small train↔held gap = generalization, not memorisation.
    </div>
  </Panel>;
}

/* ── LEARNING: COMPOSITE REWARD BREAKDOWN ────────────────────────────── */
function RewardPanel({terms}) {
  const rewardTerms = terms || REWARD_TERMS;
  const composite = rewardTerms.reduce((s,t)=>s+t.w*t.val,0);
  return <Panel title="Composite reward decomposition"
    sub="the scalar the meta-agent optimizes · same reward becomes the GRPO signal later">
    {rewardTerms.map(t => <MeterRow key={t.term} label={`${t.term}  (w ${t.w})`}
      value={t.val} color={t.term.includes("safety")?T.crit:t.term.includes("override")?T.kg:t.term.includes("MTTR")?T.agent:T.ok}
      right={t.val.toFixed(2)}/>)}
    <div style={{borderTop:`1px solid ${T.line}`,marginTop:6,paddingTop:8,
      fontFamily:MONO,fontSize:11,display:"flex"}}>
      <span style={{color:T.muted}}>Σ weighted composite</span><div style={{flex:1}}/>
      <span style={{color:T.text,fontWeight:700}}>{composite.toFixed(3)}</span>
    </div>
  </Panel>;
}

/* ── LEARNING: VARIANT ARCHIVE ───────────────────────────────────────── */
function ArchivePanel() {
  return <Panel title="Variant archive — meta-agent search"
    sub="every candidate kept · parent selection by score × exploration · rejects retained for lineage (DGM-Hyperagents)">
    <div style={{fontFamily:MONO,fontSize:10.5}}>
      <div style={{display:"flex",color:T.faint,borderBottom:`1px solid ${T.line}`,paddingBottom:4,marginBottom:4}}>
        <span style={{width:52}}>gen</span><span style={{width:64}}>parent</span>
        <span style={{width:80}}>held-out</span><span style={{flex:1}}/><span>status</span>
      </div>
      {ARCHIVE.map(a => {
        const kept=a.status==="kept", seed=a.status==="seed";
        const col=kept?T.ok:seed?T.muted:T.crit;
        return <div key={a.gen} style={{display:"flex",alignItems:"center",padding:"2px 0"}}>
          <span style={{width:52,color:T.agent}}>g{a.gen}</span>
          <span style={{width:64,color:T.faint}}>{a.parent}</span>
          <span style={{width:80,color:T.text}}>{a.holdout.toFixed(2)}</span>
          <div style={{flex:1}}/>
          <span style={{color:col}}>{kept?"✓ kept":seed?"seed":"✗ rejected"}</span>
        </div>;
      })}
    </div>
  </Panel>;
}

/* ── LEARNING: AGENT VERSION HISTORY ────────────────────────────────── */
function AgentVersionsPanel() {
  const [expanded, setExpanded] = useState(null);
  const statusCol = {baseline:T.faint, kept:T.ok, rejected:T.crit, current:T.agent};
  const statusIcon = {baseline:"◎", kept:"✓", rejected:"✗", current:"★"};

  return <Panel title="Agent evolution — incremental prompt & retrieval improvements"
    sub="6 generations · meta-agent rewrites one diff per batch · kept only if held-out composite improves">
    {/* Summary timeline */}
    <div style={{display:"flex",alignItems:"stretch",gap:0,marginBottom:12,overflowX:"auto"}}>
      {AGENT_VERSIONS.map((v,i) => {
        const col = statusCol[v.status];
        const isCur = v.status==="current";
        const isRej = v.status==="rejected";
        return <div key={v.gen} style={{display:"flex",alignItems:"center",flex:isRej?0:1}}>
          <div onClick={()=>setExpanded(expanded===v.gen?null:v.gen)}
            style={{cursor:"pointer",padding:"6px 8px",borderRadius:6,minWidth:isRej?44:64,
              background:isCur?T.agent+"22":isRej?T.crit+"11":T.soft,
              border:`1px solid ${isCur?T.agent:isRej?T.crit+"44":T.line}`,
              display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <span style={{fontFamily:MONO,fontSize:9,color:T.faint}}>gen-{v.gen}</span>
            <span style={{fontFamily:MONO,fontSize:14,fontWeight:700,color:col}}>{v.holdout.toFixed(2)}</span>
            <span style={{fontFamily:MONO,fontSize:8,color:col}}>{statusIcon[v.status]}</span>
          </div>
          {i < AGENT_VERSIONS.length-1 && !isRej && <div style={{
            flex:1,height:2,background:`linear-gradient(90deg,${col},${statusCol[AGENT_VERSIONS[i+1]?.status]||T.faint})`,
            minWidth:8,opacity:0.4}}/>}
        </div>;
      })}
    </div>
    <div style={{fontFamily:MONO,fontSize:9,color:T.faint,display:"flex",gap:14,marginBottom:10}}>
      <span><span style={{color:T.agent}}>★</span> current</span>
      <span><span style={{color:T.ok}}>✓</span> kept</span>
      <span><span style={{color:T.crit}}>✗</span> rejected</span>
      <span style={{marginLeft:"auto",color:T.muted}}>click gen to expand diff →</span>
    </div>

    {/* Expanded version detail */}
    {expanded !== null && (() => {
      const v = AGENT_VERSIONS.find(x=>x.gen===expanded);
      if (!v) return null;
      const col = statusCol[v.status];
      return <div style={{border:`1px solid ${col}44`,borderRadius:8,padding:10,
        background:T.bg,marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:col}}>gen-{v.gen}</span>
          <span style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{v.promptVersion}</span>
          <div style={{flex:1}}/>
          <span style={{fontFamily:MONO,fontSize:9,padding:"1px 7px",borderRadius:4,
            border:`1px solid ${col}`,color:col}}>{v.status}</span>
        </div>
        <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,marginBottom:8,lineHeight:1.6}}>
          {v.keyChange}
        </div>
        <div style={{display:"flex",gap:16,marginBottom:8}}>
          <div><div style={{fontFamily:MONO,fontSize:18,fontWeight:700,color:col}}>{v.holdout.toFixed(2)}</div>
            <div style={{fontFamily:MONO,fontSize:9,color:T.faint}}>held-out</div></div>
          <div><div style={{fontFamily:MONO,fontSize:18,fontWeight:700,color:T.warn}}>{v.overrideRate*100|0}%</div>
            <div style={{fontFamily:MONO,fontSize:9,color:T.faint}}>override rate</div></div>
          <div><div style={{fontFamily:MONO,fontSize:18,fontWeight:700,color:T.text}}>{v.mttr}</div>
            <div style={{fontFamily:MONO,fontSize:9,color:T.faint}}>MTTR (ticks)</div></div>
          <div style={{flex:1}}/>
          <div style={{fontFamily:MONO,fontSize:10,color:T.faint,textAlign:"right",maxWidth:180}}>
            {v.retrievalStrategy}
          </div>
        </div>
        {v.metaDiff && <div>
          <div style={{fontFamily:MONO,fontSize:9,letterSpacing:1,color:T.faint,marginBottom:3}}>DIFF FROM PREV GEN</div>
          <pre style={{fontFamily:MONO,fontSize:10.5,lineHeight:1.55,background:"#0A0D11",
            border:`1px solid ${T.line}`,borderRadius:5,padding:"8px 10px",overflowX:"auto",margin:0}}>
            {v.metaDiff.split("\n").map((l,i)=><div key={i} style={{
              color:l.startsWith("+")?T.ok:l.startsWith("-")?T.crit:T.muted
            }}>{l}</div>)}
          </pre>
        </div>}
        {v.knownFailures?.length>0 && <div style={{marginTop:8}}>
          <div style={{fontFamily:MONO,fontSize:9,letterSpacing:1,color:T.faint,marginBottom:3}}>KNOWN FAILURES AT THIS GEN</div>
          {v.knownFailures.map((f,i)=><div key={i} style={{fontFamily:MONO,fontSize:10,
            color:T.warn,paddingLeft:8,borderLeft:`2px solid ${T.warn}44`,marginBottom:2}}>⚠ {f}</div>)}
        </div>}
        {v.status==="current" && <div style={{marginTop:8,fontFamily:MONO,fontSize:10,
          color:T.ok,borderTop:`1px solid ${T.line}`,paddingTop:6}}>
          ✓ Currently deployed — zero known failure classes remaining.
        </div>}
      </div>;
    })()}

    {/* Compact table view */}
    <div style={{fontFamily:MONO,fontSize:10}}>
      <div style={{display:"flex",color:T.faint,borderBottom:`1px solid ${T.line}`,
        paddingBottom:4,marginBottom:4}}>
        <span style={{width:52}}>gen</span>
        <span style={{width:88}}>retrieval</span>
        <span style={{width:72}}>held-out</span>
        <span style={{width:72}}>override%</span>
        <span style={{flex:1}}>key change</span>
        <span style={{width:60,textAlign:"right"}}>status</span>
      </div>
      {AGENT_VERSIONS.map(v => {
        const col = statusCol[v.status];
        const isRej = v.status==="rejected";
        return <div key={v.gen} onClick={()=>setExpanded(expanded===v.gen?null:v.gen)}
          style={{display:"flex",alignItems:"center",padding:"3px 0",cursor:"pointer",
            opacity:isRej?0.6:1,background:expanded===v.gen?T.soft:"transparent",
            borderRadius:4,paddingLeft:4}}>
          <span style={{width:52,color:T.agent}}>g{v.gen}</span>
          <span style={{width:88,color:T.faint,overflow:"hidden",textOverflow:"ellipsis",
            whiteSpace:"nowrap",paddingRight:4,fontSize:9}}>{v.retrievalStrategy.split(" ").slice(0,2).join(" ")}</span>
          <span style={{width:72,color:col,fontWeight:v.status==="current"?700:400}}>{v.holdout.toFixed(2)}</span>
          <span style={{width:72,color:T.warn}}>{(v.overrideRate*100)|0}%</span>
          <span style={{flex:1,color:T.muted,overflow:"hidden",textOverflow:"ellipsis",
            whiteSpace:"nowrap",paddingRight:8,fontSize:9.5}}>{v.keyChange.split(".")[0]}</span>
          <span style={{width:60,textAlign:"right",color:col}}>{statusIcon[v.status]} {v.status}</span>
        </div>;
      })}
    </div>
  </Panel>;
}

/* ── LEARNING LAB TAB ────────────────────────────────────────────────── */
function LearningTab({metrics, metaResult, onRunMeta, metaLoading}) {
  const [showDiff,setShowDiff] = useState(false);
  const overrideData = metrics?.overrideTrend || OVERRIDE_DATA;
  const genData = metrics?.genScores || GEN_DATA;
  const metaDiff = metaResult?.diff || META_DIFF;
  const tk = {fill:T.faint, fontSize:9};
  const tt = {contentStyle:{background:T.soft,border:`1px solid ${T.line}`,fontSize:11}};
  return <div style={{display:"flex",flexDirection:"column",gap:12}}>
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,letterSpacing:2}}>
      LEARNING PLANE — OFFLINE · SANDBOXED · ALL METRICS ON HELD-OUT SCENARIOS
      {metrics && <span style={{color:T.ok,marginLeft:12}}>● live from backend</span>}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      {/* Override rate chart with spikes */}
      <Panel title="Override rate ↓ — KG institutional memory"
        sub={`headline metric · spikes = new fault classes · current ${metrics ? ((metrics.overrideRate||0)*100).toFixed(0)+"%" : "17%"}`}
        right={metrics && <Chip label="hit-rate" value={`${((metrics.hitRate||0)*100).toFixed(0)}%`} color={T.agent}/>}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={overrideData} margin={{top:8,right:12,bottom:8,left:-18}}>
            <XAxis dataKey="ep" tick={tk} stroke={T.line}/>
            <YAxis tick={tk} stroke={T.line} unit="%" domain={[0,95]}/>
            <Tooltip {...tt} formatter={(v)=>`${v}%`}/>
            {/* Gen boundary markers */}
            <ReferenceLine x={1}  stroke={T.faint} strokeDasharray="3 3"
              label={{value:"g0",position:"top",fill:T.faint,fontSize:8,fontFamily:MONO}}/>
            <ReferenceLine x={17} stroke={T.agent} strokeDasharray="3 3"
              label={{value:"g2",position:"top",fill:T.agent,fontSize:8,fontFamily:MONO}}/>
            <ReferenceLine x={21} stroke={T.agent} strokeDasharray="3 3"
              label={{value:"g3",position:"top",fill:T.agent,fontSize:8,fontFamily:MONO}}/>
            <ReferenceLine x={25} stroke={T.ok} strokeDasharray="3 3"
              label={{value:"g4",position:"top",fill:T.ok,fontSize:8,fontFamily:MONO}}/>
            <ReferenceLine x={29} stroke={T.ok} strokeDasharray="3 3"
              label={{value:"g5",position:"top",fill:T.ok,fontSize:8,fontFamily:MONO}}/>
            <Line dataKey="rate" stroke={T.kg} dot={false} strokeWidth={2} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
        <div style={{fontFamily:MONO,fontSize:10,color:T.muted,marginTop:4,lineHeight:1.6}}>
          <span style={{color:T.warn}}>↑ spikes</span> = new fault class introduced (NIC at ep5, power-droop at ep13) — agent has zero KG coverage, rate jumps.<br/>
          <span style={{color:T.ok}}>↓ falls</span> = KG corrections accumulate + meta-agent code improvements take effect.
        </div>
      </Panel>
      <Panel title="Composite score ↑ — meta-agent evolution"
        sub="train vs held-out · held-out proves generalization, not memorisation">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={genData} margin={{top:8,right:12,bottom:8,left:-18}}>
            <XAxis dataKey="gen" tick={tk} stroke={T.line}/>
            <YAxis tick={tk} stroke={T.line} domain={[0,.85]}/>
            <Tooltip {...tt}/>
            <Legend wrapperStyle={{fontSize:10,fontFamily:MONO}}/>
            <Line dataKey="train"   stroke={T.agent} dot strokeWidth={2} isAnimationActive={false}/>
            <Line dataKey="holdout" stroke={T.ok}    dot strokeWidth={2} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
        <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
          <div style={{fontFamily:MONO,fontSize:10,color:T.muted,flex:1}}>
            Small train↔held gap = generalisation. Both lines rise = meta-agent finds real improvements, not scenario memorisation.
          </div>
          <Btn color={T.agent} onClick={()=>setShowDiff(s=>!s)}>
            {showDiff?"Hide":"Show"} gen-4→5 diff
          </Btn>
          {onRunMeta && <Btn color={T.kg} onClick={onRunMeta} disabled={metaLoading}>
            {metaLoading?"Running…":"Run meta-agent"}
          </Btn>}
        </div>
      </Panel>
    </div>
    {showDiff && <Panel title="Gen-4 → gen-5: what the meta-agent wrote"
      sub={metaResult?.explanation || "machine-generated · accepted because held-out 0.61 → 0.64 · decisive fix for fan-failure deception"}>
      <pre style={{fontFamily:MONO,fontSize:11,lineHeight:1.6,background:"#0A0D11",
        border:`1px solid ${T.line}`,borderRadius:6,padding:12,overflowX:"auto"}}>
        {metaDiff.split("\n").map((l,i)=><div key={i} style={{
          color:l.startsWith("+")?T.ok:l.startsWith("-")?T.crit:l.startsWith("@")?T.agent:T.muted
        }}>{l}</div>)}
      </pre>
      {metaResult && <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,marginTop:6}}>
        Projected held-out improvement: +{metaResult.projectedImprovement?.toFixed(2) || "0.03"} → gen-{metaResult.newGen}
      </div>}
    </Panel>}

    {/* Agent version history */}
    <AgentVersionsPanel/>

    {/* Variant archive */}
    <ArchivePanel/>
  </div>;
}

/* ── KG: RETRIEVAL TRACE ─────────────────────────────────────────────── */
function RetrievalTracePanel({hits, signature}) {
  const rows = hits?.length ? hits : RETRIEVAL_TRACE;
  const sig = signature || "temp↑/fan↓ @ R2-N5";
  return <Panel title="Retrieval trace — gen-4 similarity lookup"
    sub={`query: sig ${sig} · top-k by Jaccard · corrections ranked above seeds`}>
    <div style={{fontFamily:MONO,fontSize:10.5}}>
      {rows.map((r,i)=>{
        const isCorr=(r.kind||"correction")==="correction";
        return <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,
          borderLeft:`2px solid ${isCorr?T.kg:T.line}`,paddingLeft:8}}>
          <span style={{color:isCorr?T.kg:T.muted,width:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.sig}</span>
          <div style={{flex:1,height:6,background:T.soft,borderRadius:3}}>
            <div style={{width:r.sim*100+"%",height:"100%",background:isCorr?T.kg:T.faint,borderRadius:3}}/>
          </div>
          <span style={{color:T.text,width:36,textAlign:"right"}}>{r.sim.toFixed(2)}</span>
        </div>;
      })}
    </div>
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginTop:2}}>
      This is the gen-3→4 change in action: exact-label lookup would have missed the near-miss at 0.88.
    </div>
  </Panel>;
}

/* ── KG: STATS ───────────────────────────────────────────────────────── */
function KGStatsPanel({corrections, hitRate}) {
  const counts = {symptom:KG_NODES.filter(n=>n.kind==="symptom").length,
    cause:KG_NODES.filter(n=>n.kind==="cause").length,
    action:KG_NODES.filter(n=>n.kind==="action").length,
    correction:corrections.length};
  const rate = hitRate ?? Math.min(0.98, 0.62 + corrections.length*0.05);
  return <Panel title="KG stats">
    <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:10}}>
      {[["symptoms",counts.symptom,T.warn],["causes",counts.cause,T.crit],
        ["actions",counts.action,T.ok],["corrections",counts.correction,T.kg]].map(([l,v,c])=>
        <div key={l} style={{display:"flex",flexDirection:"column"}}>
          <span style={{fontFamily:MONO,fontSize:18,fontWeight:700,color:c}}>{v}</span>
          <span style={{fontFamily:MONO,fontSize:9,color:T.faint,letterSpacing:1}}>{l}</span>
        </div>)}
    </div>
    <MeterRow label="retrieval hit-rate (matching sig found)" value={rate} color={T.agent} right={(rate*100).toFixed(0)+"%"}/>
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginTop:2}}>
      Hit-rate climbs with each correction — more institutional memory, fewer repeat misdiagnoses.
    </div>
  </Panel>;
}

/* ── KG: KNOWLEDGE DB INGESTION ──────────────────────────────────────── */
function KnowledgeDBPanel() {
  const [url, setUrl]             = useState("");
  const [status, setStatus]       = useState(null); // {ok, msg}
  const [ingesting, setIngesting] = useState(false);
  const [history, setHistory]     = useState([]);
  const [dragOver, setDragOver]   = useState(false);

  async function ingest(payload) {
    if (!BACKEND_HTTP) {
      setStatus({ok:false, msg:"Backend not connected — set VITE_BACKEND_HTTP in .env and start python backend/main.py"});
      return;
    }
    setIngesting(true); setStatus(null);
    try {
      const resp = await fetch(`${BACKEND_HTTP}/api/kg/ingest`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload),
      });
      const data = await resp.json();
      if (resp.ok) {
        setStatus({ok:true, msg:`+${data.added} nodes · +${data.edges} edges — ${data.summary||"extraction complete"}`});
        setHistory(h=>[{source:payload.url||payload.filename||"text input", added:data.added, edges:data.edges}, ...h]);
      } else {
        setStatus({ok:false, msg:data.detail||"Ingestion failed"});
      }
    } catch(e) {
      setStatus({ok:false, msg:e.message});
    } finally {
      setIngesting(false);
    }
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => ingest({filename:file.name, text:evt.target.result.slice(0,12000)});
    reader.readAsText(file);
  }

  function openFilePicker() {
    const inp = document.createElement("input");
    inp.type="file"; inp.accept=".txt,.md,.log,.pdf,.json,.csv";
    inp.onchange = evt => handleFile(evt.target.files[0]);
    inp.click();
  }

  return (
    <Panel title="Knowledge DB — Document Ingestion"
      sub="feed runbooks, postmortems, or failure logs · Gemini extracts failure patterns and evolves the KG">
      {/* URL input */}
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <input value={url} onChange={e=>setUrl(e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&url.trim()&&!ingesting){ingest({url:url.trim()});setUrl("");} }}
          placeholder="Paste document URL (runbook, postmortem, wiki page)…"
          style={{flex:1,background:T.bg,border:`1px solid ${T.line}`,borderRadius:6,
            color:T.text,fontFamily:MONO,fontSize:11,padding:"7px 9px",outline:"none"}}/>
        <Btn color={T.kg}
          onClick={()=>{if(url.trim()){ingest({url:url.trim()});setUrl("");}}}
          disabled={!url.trim()||ingesting}>
          {ingesting?"Parsing…":"Ingest URL"}
        </Btn>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDragOver(true);}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{e.preventDefault();setDragOver(false);handleFile(e.dataTransfer.files[0]);}}
        onClick={openFilePicker}
        style={{
          border:`2px dashed ${dragOver?T.kg:T.line}`, borderRadius:8,
          padding:"16px 12px", textAlign:"center", cursor:"pointer",
          fontFamily:MONO, fontSize:11, color:dragOver?T.kg:T.muted,
          background:dragOver?T.kg+"0D":"transparent",
          transition:"all 0.15s", marginBottom:10,
        }}>
        ↓ drop file · or click to browse
        <div style={{fontSize:9.5,color:T.faint,marginTop:3}}>
          .txt · .md · .log · .json — Gemini extracts symptoms → causes → actions
        </div>
      </div>

      {/* Status */}
      {status && (
        <div style={{fontFamily:MONO,fontSize:11,padding:"7px 10px",borderRadius:6,marginBottom:8,
          background:status.ok?T.ok+"1A":T.crit+"1A",
          border:`1px solid ${status.ok?T.ok+"44":T.crit+"44"}`,
          color:status.ok?T.ok:T.crit}}>
          {status.ok?"✓ ":"✗ "}{status.msg}
        </div>
      )}

      {/* Ingestion log */}
      {history.length>0 && (
        <div style={{fontFamily:MONO,fontSize:10}}>
          <div style={{color:T.faint,letterSpacing:1,marginBottom:4}}>INGESTION LOG</div>
          {history.map((h,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,
              padding:"4px 0",borderTop:`1px solid ${T.line}`}}>
              <span style={{color:T.kg}}>+{h.added} nodes</span>
              <span style={{color:T.faint}}>+{h.edges} edges</span>
              <span style={{color:T.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {h.source}
              </span>
            </div>
          ))}
        </div>
      )}

      {!BACKEND_HTTP && (
        <div style={{fontFamily:MONO,fontSize:10,color:T.faint,
          borderTop:`1px solid ${T.line}`,paddingTop:8,marginTop:6}}>
          ℹ Backend required — set VITE_BACKEND_HTTP in .env and start <code>python backend/main.py</code>
        </div>
      )}
    </Panel>
  );
}

/* ── KNOWLEDGE GRAPH TAB ─────────────────────────────────────────────── */
function KnowledgeGraphTab({corrections, retrievalHits, focusNode, hitRate}) {
  const [sel,setSel] = useState(null);
  const sig = `temp↑/fan↓ @ ${focusNode || "R2-N5"}`;
  const kindColor = {symptom:T.warn, cause:T.crit, action:T.ok, correction:T.kg};
  const kindLabel = {symptom:"Symptom", cause:"Root cause", action:"Remediation", correction:"Operator correction"};
  const allNodes = [...KG_NODES, ...corrections];
  const corrEdges = corrections.flatMap(c=>[{from:"s1",to:c.id,kind:"correction"},{from:c.id,to:"a1",kind:"correction"}]);
  const allEdges = [...KG_SEED_EDGES.map(([f,t])=>({from:f,to:t,kind:"seed"})), ...corrEdges];
  const selNode = allNodes.find(n=>n.id===sel);
  return <div style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:12,alignItems:"start"}}>
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
    <Panel title="Knowledge graph"
      sub={`${allNodes.length} nodes · ${allEdges.length} edges · seeded from OPT-175B logbook + Alibaba GPU trace · amber = live operator corrections`}
      right={<a href="https://github.com/alibaba/clusterdata" target="_blank" rel="noreferrer"
        style={{fontFamily:MONO,fontSize:9,color:T.agent,textDecoration:"none",
        border:`1px solid ${T.agent}44`,borderRadius:4,padding:"2px 6px"}}>
        ↗ Alibaba trace dataset
      </a>}>
      <svg viewBox="0 0 430 480" style={{width:"100%",height:480}}>
        {allEdges.map((e,i)=>{
          const A=allNodes.find(n=>n.id===e.from), B=allNodes.find(n=>n.id===e.to);
          if(!A||!B) return null;
          return <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y}
            stroke={e.kind==="correction"?T.kg:T.line}
            strokeWidth={e.kind==="correction"?1.5:1}
            strokeDasharray={e.kind==="correction"?"4 2":undefined} strokeOpacity={.7}/>;
        })}
        {allNodes.map(n=>{
          const col=kindColor[n.kind]||T.muted, isSel=n.id===sel;
          const r = n.kind==="correction"?8:n.kind==="symptom"?6:n.kind==="action"?6:7;
          return <g key={n.id} onClick={()=>setSel(isSel?null:n.id)} style={{cursor:"pointer"}}>
            <circle cx={n.x} cy={n.y} r={r}
              fill={col} fillOpacity={isSel?1:.75}
              stroke={isSel?T.text:col} strokeWidth={isSel?2:0.5}/>
            <text x={n.x} y={n.y-r-2} textAnchor="middle"
              fill={isSel?T.text:T.muted} fontSize={7.5} fontFamily={MONO}>{n.label}</text>
          </g>;
        })}
      </svg>
      <div style={{fontFamily:MONO,fontSize:10,color:T.muted,display:"flex",gap:14,marginTop:4}}>
        {Object.entries(kindLabel).map(([k,l])=><span key={k}><Dot color={kindColor[k]}/>{l}</span>)}
      </div>
    </Panel>
    <RetrievalTracePanel hits={retrievalHits} signature={sig}/>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <KGStatsPanel corrections={corrections} hitRate={hitRate ?? (retrievalHits?.length ? Math.min(0.98, 0.62 + corrections.length*0.05) : undefined)}/>
      <Panel title="Node detail" sub={selNode?selNode.label:"click a node"}>
        {!selNode && <div style={{fontFamily:MONO,fontSize:11,color:T.faint}}>
          Amber nodes are operator corrections — each one is a lesson the system learned from human disagreement.
        </div>}
        {selNode && <div style={{fontFamily:MONO,fontSize:11,lineHeight:1.9}}>
          <div><span style={{color:T.faint,minWidth:64,display:"inline-block"}}>type</span>
            <span style={{color:kindColor[selNode.kind]}}>{kindLabel[selNode.kind]}</span></div>
          {selNode.kind==="correction" && <>
            <div><span style={{color:T.faint,minWidth:64,display:"inline-block"}}>rejected</span>
              <span style={{color:T.crit}}>{selNode.rejected}</span></div>
            <div><span style={{color:T.faint,minWidth:64,display:"inline-block"}}>applied</span>
              <span style={{color:T.ok}}>{selNode.applied}</span></div>
            <div><span style={{color:T.faint,minWidth:64,display:"inline-block"}}>context</span>
              <span style={{color:T.muted}}>{selNode.ctx}</span></div>
          </>}
        </div>}
      </Panel>
      <Panel title="Three learning timescales">
        <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,lineHeight:2}}>
          <div><span style={{color:T.agent}}>Per incident (sec):</span> KG retrieval — context changes, weights unchanged</div>
          <div><span style={{color:T.kg}}>Per override (min):</span> KG memory — correction written permanently</div>
          <div><span style={{color:T.ok}}>Per generation (off):</span> agent code rewritten by meta agent</div>
        </div>
      </Panel>
      <Panel title="Why non-parametric?">
        <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,lineHeight:1.9}}>
          No catastrophic forgetting. Every correction is auditable, inspectable, reversible. A bad lesson can be deleted — not untrained. This is what makes ops automation safe to trust.
        </div>
      </Panel>
      <KnowledgeDBPanel/>
    </div>
  </div>;
}

/* ── TRAINING: DATASET COMPOSITION ───────────────────────────────────── */
function DataCompositionPanel({pairs}) {
  const mix = DATA_MIX.map(m=>({...m, n:m.n==="live"?pairs.length:m.n}));
  const total = mix.reduce((s,m)=>s+m.n,0) || 1;
  return <Panel title="Dataset composition" sub="where the preference + KG data comes from · overrides grow live">
    <div style={{display:"flex",height:12,borderRadius:6,overflow:"hidden",marginBottom:10}}>
      {mix.map(m=><div key={m.src} title={`${m.src}: ${m.n}`}
        style={{width:(m.n/total*100)+"%",background:m.color}}/>)}
    </div>
    {mix.map(m=><div key={m.src} style={{display:"flex",alignItems:"center",gap:8,
      fontFamily:MONO,fontSize:10.5,marginBottom:4}}>
      <Dot color={m.color}/><span style={{color:T.muted}}>{m.src}</span>
      <div style={{flex:1}}/><span style={{color:T.text}}>{m.n}</span>
    </div>)}
  </Panel>;
}

/* ── TRAINING: REAL-WORLD FAILURE DATA SOURCES (the "data hub") ───────── */
function DataSourcesPanel() {
  return <Panel title="Failure data sources — grounding"
    sub="public GPU/pretraining failure corpora · no public TPU crash dataset exists — that data is internal to Google">
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {DATA_SOURCES.map(d=><div key={d.name} style={{border:`1px solid ${T.line}`,borderRadius:7,padding:"7px 9px"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontSize:12,fontWeight:600}}>{d.name}</span>
          <div style={{flex:1}}/>
          <span style={{fontFamily:MONO,fontSize:9,padding:"1px 6px",borderRadius:4,
            border:`1px solid ${d.live?T.ok:T.faint}`,color:d.live?T.ok:T.faint}}>
            {d.live?"WIRED":"roadmap"}</span>
        </div>
        <div style={{fontFamily:MONO,fontSize:10,color:T.agent,marginBottom:2}}>use: {d.use}</div>
        <div style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{d.note}</div>
      </div>)}
    </div>
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,borderTop:`1px solid ${T.line}`,marginTop:10,paddingTop:8}}>
      TPU note: TPU reliability data is not public. GPU pretraining failures (OPT, BLOOM, Llama-3) are the honest proxy — same failure classes (thermal, memory, NIC, power), same operator-override dynamics.
    </div>
  </Panel>;
}

/* ── TRAINING DATA TAB ───────────────────────────────────────────────── */
function exportPairsJSONL(pairs, priorCount) {
  const allPairs = [
    // Prior synthetic pairs
    ...Array.from({length:priorCount},(_, i)=>({
      id:i+1, context:`sig: sim-fault @ R${(i%4)+1}-N${(i%8)+1} t${String(i*3+10).padStart(3,"0")}`,
      rejected:["throttle_job","migrate_workload","restart_node"][i%3],
      chosen:["ramp_fans","drain_node","escalate","ramp_fans"][i%4],
      source:"simulator_episode",
    })),
    // Live session pairs
    ...pairs.map(p=>({id:priorCount+p.id, context:p.ctx, rejected:p.rejected, chosen:p.chosen, source:"operator_override"})),
  ];
  const blob = new Blob([allPairs.map(p=>JSON.stringify(p)).join("\n")], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download="infrabrain_preference_pairs.jsonl"; a.click();
  URL.revokeObjectURL(url);
}

function TrainingDataTab({pairs, priorCount=237}) {
  const PRIOR=priorCount, total=PRIOR+pairs.length;
  // Show live pair as schema example, fall back to static example
  const lastPair = pairs.length > 0 ? pairs[pairs.length-1] : null;
  const SCHEMA = lastPair
    ? JSON.stringify({id:PRIOR+lastPair.id, context:lastPair.ctx, rejected:lastPair.rejected, chosen:lastPair.chosen, source:"operator_override"}, null, 2)
    : `{\n  "id":       1,\n  "context":  "sig: temp↑/fan↓ @ R2-N5 t042",\n  "rejected": "throttle_job",\n  "chosen":   "ramp_fans",\n  "source":   "operator_override"\n}`;

  return <div style={{display:"flex",flexDirection:"column",gap:12}}>
    {/* Future scope banner */}
    <div style={{background:T.agent+"11",border:`1px solid ${T.agent}44`,borderRadius:8,
      padding:"10px 16px",display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontFamily:MONO,fontSize:20}}>🔭</span>
      <div>
        <div style={{fontFamily:MONO,fontSize:12,fontWeight:700,color:T.agent,marginBottom:2}}>
          FUTURE SCOPE — Training Data Pipeline
        </div>
        <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted}}>
          Architecture ready · preference pairs accumulate every episode · two steps from full RL.
          Current system uses KG memory + meta-agent code evolution — no model finetuning required yet.
        </div>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Panel title="Preference pairs" sub={`${total} total (${PRIOR} prior + ${pairs.length} this session) · every override produces one`}>
        <div style={{fontFamily:MONO,fontSize:28,color:T.kg}}>{total}</div>
        <div style={{fontSize:11,color:T.muted,marginBottom:10}}>labeled preference pairs exported</div>
        <div style={{maxHeight:220,overflowY:"auto"}}>
          {pairs.length===0 && <div style={{fontFamily:MONO,fontSize:11,color:T.faint}}>
            Override an incident in Observability to see a pair land here.
          </div>}
          {pairs.map(p => <div key={p.id} style={{borderLeft:`2px solid ${T.kg}`,
            paddingLeft:8,marginBottom:8,fontFamily:MONO,fontSize:10.5}}>
            <div style={{color:T.muted}}>{p.ctx}</div>
            <div><span style={{color:T.crit}}>✗ {p.rejected}</span> → <span style={{color:T.ok}}>✓ {p.chosen}</span></div>
          </div>)}
        </div>
      </Panel>
      <Panel title="Pair schema — JSONL export format"
        sub={lastPair ? "showing most recent live pair" : "static example — override an incident to generate real pairs"}>
        <pre style={{fontFamily:MONO,fontSize:11,lineHeight:1.7,background:"#0A0D11",
          border:`1px solid ${lastPair?T.kg:T.line}`,borderRadius:6,padding:10,
          color:lastPair?T.kg:T.muted,margin:0}}>{SCHEMA}</pre>
        <div style={{marginTop:10,display:"flex",gap:8,alignItems:"center"}}>
          <Btn color={T.kg} onClick={()=>exportPairsJSONL(pairs,PRIOR)}>
            ↓ Export {total} pairs as JSONL
          </Btn>
          <span style={{fontFamily:MONO,fontSize:10,color:T.faint}}>
            ready for DPO / GRPO training
          </span>
        </div>
      </Panel>
    </div>
    <DataCompositionPanel pairs={pairs}/>
  </div>;
}

/* ── OVERVIEW: ARCHITECTURE DIAGRAM ─────────────────────────────────── */
function ArchitectureDiagram() {
  const W=640, H=446;
  const aC=[T.agent,T.kg,T.ok,T.muted];

  const Bx=({x,y,w,h,col,t,s,bold})=>(
    <g>
      <rect x={x} y={y} width={w} height={h} rx={7}
        fill={col+"1A"} stroke={col} strokeWidth={bold?2:1.5}/>
      <text x={x+w/2} y={s?y+h/2-5:y+h/2+5} textAnchor="middle"
        fill={col} fontSize={bold?12:11} fontFamily={MONO} fontWeight={700}>{t}</text>
      {s&&<text x={x+w/2} y={y+h/2+10} textAnchor="middle"
        fill={T.faint} fontSize={8.5} fontFamily={MONO}>{s}</text>}
    </g>
  );
  const Ar=({x1,y1,x2,y2,col,dashed,label,lx,ly})=>(
    <g opacity={0.9}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={1.5}
        strokeDasharray={dashed?"5 3":undefined}
        markerEnd={`url(#ma${col.replace("#","")})`}/>
      {label&&<text x={lx??((x1+x2)/2+5)} y={ly??((y1+y2)/2-3)}
        fill={col} fontSize={8.5} fontFamily={MONO}>{label}</text>}
    </g>
  );
  const Pa=({d,col,dashed,label,lx,ly})=>(
    <g opacity={0.85}>
      <path d={d} fill="none" stroke={col} strokeWidth={1.5}
        strokeDasharray={dashed?"5 3":undefined}
        markerEnd={`url(#ma${col.replace("#","")})`}/>
      {label&&<text x={lx} y={ly} fill={col} fontSize={8.5} fontFamily={MONO}>{label}</text>}
    </g>
  );

  return (
    <svg viewBox="0 0 640 320" style={{width:"100%",maxHeight:320}}>
      <defs>
        {aC.map(c=>(
          <marker key={c} id={`ma${c.replace("#","")}`}
            markerWidth={8} markerHeight={8} refX={7} refY={3} orient="auto">
            <path d="M0,0 L7,3 L0,6 z" fill={c}/>
          </marker>
        ))}
      </defs>

      {/* ── Row 1: Meta Agent (full width) ── */}
      <Bx x={20} y={8} w={600} h={46} col={T.agent} bold
        t="META AGENT" s="offline · nightly batch · Loop 3"/>

      {/* ↓ code diff */}
      <Ar x1={130} y1={54} x2={130} y2={90} col={T.agent} label="rewrites code" lx={136} ly={76}/>
      {/* ↓ seeds KG */}
      <Ar x1={500} y1={54} x2={500} y2={90} col={T.kg} dashed label="seeds + updates" lx={506} ly={74}/>

      {/* ── Row 2: Task Agent + KG Store ── */}
      <Bx x={20} y={90} w={228} h={46} col={T.agent} t="TASK AGENT · gen-5" s="Gemini API · KG-augmented"/>
      <Bx x={390} y={90} w={230} h={46} col={T.kg} t="Knowledge Graph" s="SQLite · corrections + seeds"/>

      {/* Task → KG retrieval */}
      <Ar x1={248} y1={107} x2={390} y2={107} col={T.kg} label="retrieval (k=5) · Loop 1" lx={256} ly={101}/>
      {/* KG → Task correction write (dashed) */}
      <Ar x1={390} y1={121} x2={248} y2={121} col={T.kg} dashed/>

      {/* ↓ diagnosis */}
      <Ar x1={130} y1={136} x2={130} y2={172} col={T.ok} label="streams diagnosis" lx={136} ly={158}/>

      {/* ── Row 3: SRE Console ── */}
      <Bx x={20} y={172} w={228} h={46} col={T.ok} t="SRE Console" s="accept / override"/>

      {/* L-path: SRE → KG bottom  (Loop 2) */}
      <Pa d="M 248 195 H 504 V 136" col={T.kg} dashed
        label="Loop 2 · writes correction on override" lx={256} ly={188}/>

      {/* ↓ override → pair */}
      <Ar x1={130} y1={218} x2={130} y2={250} col={T.muted} label="override → pair" lx={136} ly={238}/>

      {/* ── Row 4: Trace Store ── */}
      <Bx x={20} y={250} w={228} h={44} col={T.muted} t="Trace Store + Pref Pairs" s="episodes · preference pairs"/>

      {/* Big L-path: Trace → right side → Meta Agent right */}
      <Pa d="M 248 272 H 630 V 31 H 620" col={T.agent} dashed
        label="Loop 3 · episode traces (nightly)" lx={256} ly={289}/>

      {/* Right side label */}
      <text x={633} y={162} textAnchor="middle" fill={T.agent} fontSize={7.5} fontFamily={MONO}
        opacity={0.6} transform="rotate(-90,633,162)">Loop 3 traces</text>
    </svg>
  );
}

/* ── OVERVIEW TAB ────────────────────────────────────────────────────── */
function OverviewTab() {
  const loops = [
    { id:"Loop 1", col:T.ok,    title:"KG Retrieval",
      sub:"per incident · seconds · no weight updates",
      desc:"Task Agent queries the Knowledge Graph with the current symptom signature. Top-5 similar corrections + seed rules are ranked and injected into the Gemini prompt. Weights never change — only context changes." },
    { id:"Loop 2", col:T.kg,    title:"KG Memory",
      sub:"per override · minutes · non-parametric write",
      desc:"SRE override writes a correction row to SQLite. Future incidents with matching signatures auto-retrieve it. Auditable and reversible — a bad lesson is a DELETE, not an un-training run." },
    { id:"Loop 3", col:T.agent, title:"Meta-Agent Evolution",
      sub:"offline · nightly batch · code rewriting",
      desc:"Meta-agent reads episode traces, clusters failures, proposes a unified diff to task-agent retrieval/prompt code. Accepted only if held-out composite score improves. DGM-Hyperagent pattern." },
  ];
  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <Panel title="InfraBrain — System Architecture"
        sub="suggest-only · nothing executes without SRE approval · self-modification sandboxed to simulator">
        <ArchitectureDiagram/>
      </Panel>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {loops.map(({id,col,title,sub,desc})=>(
          <div key={id} style={{background:T.panel,border:`1px solid ${T.line}`,
            borderTop:`3px solid ${col}`,borderRadius:8,padding:14}}>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5}}>
              <span style={{fontFamily:MONO,fontSize:9,letterSpacing:1,color:col,
                background:col+"22",padding:"1px 7px",borderRadius:3}}>{id}</span>
              <span style={{fontWeight:600,fontSize:12.5}}>{title}</span>
            </div>
            <div style={{fontFamily:MONO,fontSize:9.5,color:T.faint,marginBottom:8}}>{sub}</div>
            <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,lineHeight:1.75}}>{desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── AGENT RESPONSE (scripted now · swap in a real LLM later) ─────────── */
/*
 * To wire a real model later, replace the body of askAgent with an async
 * fetch to your backend / Gemini API and return the completion string.
 * Keep the signature (ctx) so callers don't change.
 */
function askAgent(ctx) {
  const { text, incident, node, nodeState, agentGen, corrections } = ctx;
  const q = text.toLowerCase();
  const sig = incident ? `temp↑/${incident.faultType==="fan"?"fan↓":"mem↑"} @ ${node}` : "no active signature";
  if (q.includes("why") || q.includes("explain")) {
    if (!incident) return `No active incident on ${node}. Telemetry nominal — nothing to explain right now.`;
    return incident.suggestion
      ? `My call on ${node}: ${incident.suggestion.diagnosis} → ${incident.suggestion.action} (conf ${incident.suggestion.conf}).\nKey signal: ${incident.suggestion.evidence[0]}\n${agentGen>=4?"KG similarity retrieval surfaced a matching correction, so I ranked it above the seed prior.":"Running gen-0 prior — fan signal is under-weighted vs util."}`
      : `Still analyzing ${node} — I'll post a diagnosis in ~2 ticks.`;
  }
  if (q.includes("history") || q.includes("kg") || q.includes("correction")) {
    return corrections.length
      ? `KG holds ${corrections.length} correction(s). Most recent: rejected ${corrections[corrections.length-1].rejected} → applied ${corrections[corrections.length-1].applied}. Signature match: ${sig}.`
      : `KG has no operator corrections yet for ${sig}. Override an incident to teach me.`;
  }
  if (q.includes("status") || q.includes("health") || q.includes("fleet")) {
    return `Fleet: ${node} at ${nodeState?nodeState.temp.toFixed(1)+"°C":"n/a"}. ${incident?`Active incident stage: ${incident.stage}.`:"No incident on focused node."} Ask /diagnose to re-run, or "/" for actions.`;
  }
  if (q.includes("what") && q.includes("do")) {
    return `You can Accept/Override the suggestion in the incident panel, or drive me from here — /ramp_fans, /throttle, /migrate, /drain, /restart, /borg, /escalate. Type "/" to see the palette.`;
  }
  return `Focused on ${node} (sig: ${sig}). I can /diagnose, /explain, show /history, or queue a repair. Type "/" for the action palette.`;
}

/* ── ROOT APP ────────────────────────────────────────────────────────── */
/* ── BACKEND CONFIG ───────────────────────────────────────────────────────
   Set VITE_BACKEND_WS / VITE_BACKEND_HTTP in .env to enable real backend.
   Leave unset → frontend-only demo mode (in-browser sim + scripted agent).
   ──────────────────────────────────────────────────────────────────────── */
const BACKEND_WS   = import.meta.env.VITE_BACKEND_WS   || null;
const BACKEND_HTTP = import.meta.env.VITE_BACKEND_HTTP  || null;

export default function InfraBrainApp() {
  const [tab,setTab]         = useState("Overview");
  const [running,setRunning] = useState(false);
  const [tick,setTick]       = useState(0);
  const [nodes,setNodes]     = useState(freshNodes);
  const [focusNode,setFocusNode] = useState(FAULT_NODE);
  const [agentGen,setAgentGen] = useState(0);
  const [incidents,setIncidents] = useState([]);
  const [repairs,setRepairs]     = useState([]);
  const [episodes,setEpisodes] = useState(37);
  const [kgCorr,setKgCorr]     = useState([]);
  const [pairs,setPairs]       = useState([]);
  const [chat,setChat] = useState([{role:"sys",text:'SRE console ready. Ask a question, or type "/" for actions.'}]);
  const [log,setLog] = useState([{t:0,kind:"sys",text:"Simulator ready. Press RUN — faults fire at t010 (R2-N5 fan) and t022 (R3-N2 mem)."}]);
  const [chatOpen, setChatOpen]           = useState(false);
  const [backendStatus, setBackendStatus] = useState(BACKEND_WS?"connecting":"demo");
  const [liveMetrics, setLiveMetrics]     = useState(null);
  const [retrievalHits, setRetrievalHits] = useState(null);
  const [metaResult, setMetaResult]       = useState(null);
  const [metaLoading, setMetaLoading]     = useState(false);

  const histRef  = useRef({});
  const stRef    = useRef({});
  const wsRef    = useRef(null);
  const chatRef  = useRef(null); // for streaming chat updates
  stRef.current  = {nodes,incidents,repairs,agentGen,tick,kgCorr,pairs,focusNode};

  /* ── WebSocket — connect to backend if configured ────────────────────── */
  useEffect(()=>{
    if (!BACKEND_WS) return;
    let retryTimer;

    function connect(){
      const ws = new WebSocket(BACKEND_WS);
      wsRef.current = ws;

      ws.onopen  = () => setBackendStatus("connected");
      ws.onerror = () => setBackendStatus("error");
      ws.onclose = () => {
        setBackendStatus("reconnecting");
        retryTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = e => {
        try { handleBackendMessage(JSON.parse(e.data)); }
        catch(err) { console.warn("WS parse error", err); }
      };
    }

    connect();
    return () => { wsRef.current?.close(); clearTimeout(retryTimer); };
  }, []); // eslint-disable-line

  /* ── Poll live metrics + KG retrieval when backend connected ─────────── */
  useEffect(()=>{
    if (backendStatus !== "connected" || !BACKEND_HTTP) return;
    let cancelled = false;

    async function refreshMetrics(){
      try {
        const r = await fetch(`${BACKEND_HTTP}/api/metrics`);
        if (r.ok && !cancelled) setLiveMetrics(await r.json());
      } catch {}
    }
    refreshMetrics();
    const id = setInterval(refreshMetrics, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [backendStatus]);

  useEffect(()=>{
    if (backendStatus !== "connected" || !BACKEND_HTTP) return;
    const inc = stRef.current.incidents.find(i=>i.node===focusNode && i.stage!=="resolved");
    const sig = inc
      ? `temp↑/${inc.faultType==="fan"?"fan↓":"mem↑"} @ ${focusNode}`
      : `temp↑/fan↓ @ ${focusNode}`;
    let cancelled = false;
    fetch(`${BACKEND_HTTP}/api/kg/retrieve?sig=${encodeURIComponent(sig)}&k=4`)
      .then(r=>r.ok ? r.json() : null)
      .then(d=>{ if (!cancelled && d?.hits) setRetrievalHits(d.hits); })
      .catch(()=>{});
    return () => { cancelled = true; };
  }, [backendStatus, focusNode, kgCorr.length]);

  function sendWS(msg){
    if (wsRef.current?.readyState === WebSocket.OPEN){
      wsRef.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function handleBackendMessage(msg){
    switch(msg.type){
      case "init":
        setNodes(msg.nodes||[]);
        setTick(msg.t||0);
        setIncidents(msg.incidents||[]);
        setRepairs(msg.repairs||[]);
        setLog(msg.log||[]);
        setAgentGen(msg.agentGen||0);
        setEpisodes(msg.episodes||37);
        if(msg.corrections) _hydrateKgCorr(msg.corrections);
        if(msg.pairs) setPairs(msg.pairs);
        setRunning(msg.running||false);
        break;
      case "tick":
        setNodes(msg.nodes||[]);
        setTick(msg.t||0);
        if(msg.incidents) setIncidents(msg.incidents);
        if(msg.episodes !== undefined) setEpisodes(msg.episodes);
        // hydrate history for telemetry charts
        (msg.nodes||[]).forEach(nd=>{
          const h=(histRef.current[nd.id]||=[]);
          h.push({t:msg.t,temp:nd.temp,util:nd.util,fan:nd.fan,mem:nd.mem});
          if(h.length>90) h.shift();
          histRef.current[nd.id]=h;
        });
        break;
      case "incident_update": {
        const inc=msg.incident;
        setIncidents(prev=>{
          const idx=prev.findIndex(i=>i.id===inc.id);
          return idx>=0 ? prev.map((i,j)=>j===idx?inc:i) : [...prev,inc];
        });
        // Auto-focus newly-detected incidents
        if(inc.stage==="analyzing")
          setFocusNode(f=>(!f||f===FAULT_NODE)?inc.node:f);
        break;
      }
      case "repairs":
        setRepairs(msg.repairs||[]);
        break;
      case "log":
        if(msg.entry) setLog(l=>[msg.entry,...l].slice(0,90));
        break;
      case "kg_update":
        if(msg.correction) setKgCorr(k=>{
          const pos=k.length;
          return [...k,{
            ...msg.correction,
            kind:"correction",
            label:`override #C${pos+1}`,
            x:120+(pos%4)*60, y:290,
            ctx:msg.correction.context||"",
          }];
        });
        if(msg.pair) setPairs(p=>[...p,msg.pair]);
        if(msg.allCorrections) _hydrateKgCorr(msg.allCorrections);
        break;
      case "reset":
        setNodes(msg.nodes||freshNodes());
        setTick(0); setIncidents([]); setRepairs([]);
        histRef.current={};
        if(msg.log) setLog(msg.log);
        if(msg.gen!==undefined) setAgentGen(msg.gen);
        break;
      case "running":
        setRunning(!!msg.running);
        break;
      case "episodes":
        if(msg.episodes !== undefined) setEpisodes(msg.episodes);
        break;
      case "escalation":
        addChat("sys",`⚑ ${msg.message||"Escalated to on-call (L2)."}`);
        break;
      default: break;
    }
  }

  function _hydrateKgCorr(corrections){
    setKgCorr(corrections.map((c,i)=>({
      ...c,
      kind:"correction",
      label:`override #C${i+1}`,
      x:120+(i%4)*60, y:290,
      ctx:c.context||"",
    })));
  }

  const addLog = useCallback((kind,text,node) =>
    setLog(l=>[{t:stRef.current.tick,kind,text,node},...l].slice(0,90)),[]);
  const addChat = useCallback((role,text) =>
    setChat(c=>[...c,{role,text}].slice(-60)),[]);
  const backendConnected = backendStatus==="connected";

  function buildSuggestion(n, gen, faultType, nodeId) {
    const nd=n.find(x=>x.id===nodeId)||{};
    if (faultType==="mem") {
      return gen>=4
        ? {diagnosis:"Memory leak — heap climbing to OOM", action:"migrate_workload", conf:0.88,
            evidence:[
              `mem ${nd.mem?.toFixed(0)}% — monotonic rise 10 ticks, no GC recovery`,
              `temp rising with mem, util flat (not a compute burst)`,
              "KG correction: mem↑ sig — throttle_job rejected, migrate applied"]}
        : {diagnosis:"CPU overload on training job", action:"throttle_job", conf:0.70,
            evidence:[
              `util ${nd.util?.toFixed(0)}% with rising temp`,
              `temp ${nd.temp?.toFixed(1)}°C — assuming compute-bound`,
              "KG seed: temp spike → cpu overload (mem signal not weighted)"]};
    }
    return gen>=4
      ? {diagnosis:"Fan degradation → thermal cascade", action:"ramp_fans", conf:0.91,
          evidence:[
            `fan RPM ${nd.fan?.toFixed(0)}% — sustained decline 8 ticks (leading indicator)`,
            `temp slope +3.1°C/tick while util falling (thermal throttling, not load)`,
            "KG correction #C1: identical sig — throttle_job rejected, ramp_fans applied"]}
      : {diagnosis:"CPU overload on training job", action:"throttle_job", conf:0.72,
          evidence:[
            `util ${nd.util?.toFixed(0)}% sustained 6 ticks before temp spike`,
            `temp ${nd.temp?.toFixed(1)}°C — correlated with workload burst`,
            "KG seed: temp spike + util high → cpu overload (fan signal not weighted)"]};
  }

  function recordOverrideState(rejected, applied, node, t){
    setKgCorr(k=>[...k,{id:`corr-${k.length+1}`,label:`override #C${k.length+1}`,kind:"correction",
      x:120+(k.length%4)*60,y:290,rejected,applied,ctx:`${node} gen-${stRef.current.agentGen}`}]);
    setPairs(p=>[...p,{id:p.length+1,ctx:`sig: temp↑/fan↓ @ ${node} t${t}`,
      rejected,chosen:applied,source:"operator_override"}]);
  }

  useEffect(()=>{
    // In-browser sim — disabled when backend WebSocket is connected
    if (!running || backendConnected) return;
    const h = setInterval(()=>{
      const S = stRef.current;
      const t = S.tick+1;
      setTick(t);
      const next = stepNodes(S.nodes, t, S.repairs);
      setNodes(next);
      next.forEach(nd=>{
        const h2=(histRef.current[nd.id]||=[]);
        h2.push({t, temp:+nd.temp.toFixed(1), util:+nd.util.toFixed(1), fan:+nd.fan.toFixed(1), mem:+nd.mem.toFixed(1)});
        if(h2.length>90) h2.shift();
      });

      let incs = S.incidents.map(i=>({...i}));
      let reps = S.repairs.map(r=>({...r}));
      const removeRep = new Set();
      const addRep = [];

      // Repair countdown
      reps.forEach(rep=>{
        if(!rep.effectApplied){
          rep.ticksLeft--;
          if(rep.ticksLeft<=0){
            rep.effectApplied=true;
            addLog("sys",`Repair task ${rep.taskId} complete on ${rep.node} — ${rep.action} applied. Monitoring post-fix window.`,rep.node);
            const inc=incs.find(i=>i.node===rep.node && i.stage==="repairing");
            if(inc){inc.stage="monitoring"; inc.monitorFrom=t;}
          }
        }
      });

      // Watcher fires per fault source
      FAULTS.forEach(f=>{
        const nd=next.find(n=>n.id===f.node);
        const existing=incs.find(i=>i.node===f.node && i.stage!=="resolved");
        if(!existing && t>=f.start && nd.temp>=75){
          addLog("watch",`Watcher: ${f.node} temp ${nd.temp.toFixed(1)}°C fan ${nd.fan.toFixed(0)}% mem ${nd.mem.toFixed(0)}% (z=3.4) — anomaly flagged.`,f.node);
          incs.push({id:`inc-${f.node}-${t}`, node:f.node, faultType:f.type, stage:"analyzing", since:t});
          setFocusNode(fn=>fn===FAULT_NODE||!fn ? f.node : fn);
        }
      });

      // Agent suggestion (2 ticks after detection)
      incs.forEach(inc=>{
        if(inc.stage==="analyzing" && t>=inc.since+2){
          const sug=buildSuggestion(next, S.agentGen, inc.faultType, inc.node);
          addLog("agent",`Task agent (gen-${S.agentGen}): ${sug.diagnosis} → ${sug.action} (conf ${sug.conf}). Awaiting SRE decision.`,inc.node);
          inc.stage="suggested"; inc.suggestion=sug;
        }
      });

      // Post-fix assessment
      incs.forEach(inc=>{
        if(inc.stage==="monitoring"){
          const rep=reps.find(r=>r.node===inc.node && r.effectApplied);
          const nd=next.find(n=>n.id===inc.node);
          if(rep){
            const elapsed=t-(inc.monitorFrom||0);
            if(elapsed>=6 && nd.temp<75){
              addLog("sys",`Resolved — ${inc.node} stable 6 ticks post-fix. Time-to-recurrence: none. Episode logged.`,inc.node);
              inc.stage="resolved";
              removeRep.add(rep.taskId);
              setEpisodes(e=>e+1);
            } else if(nd.temp>=92 && inc.node===FAULT_NODE && !inc.autoOverridden){
              const sug=inc.suggestion;
              addLog("watch",`Post-fix: temp ${nd.temp.toFixed(1)}°C — fix ineffective. Scripted operator override firing.`,inc.node);
              addLog("op",`Override: rejected ${sug.action}, applying ramp_fans. Correction → KG. Pair exported.`,inc.node);
              recordOverrideState(sug.action,"ramp_fans",inc.node,t);
              removeRep.add(rep.taskId);
              addRep.push({taskId:`rt-${7000+t}`,node:inc.node,action:"ramp_fans",ticksLeft:4,effectApplied:false});
              inc.stage="repairing"; inc.autoOverridden=true;
              inc.suggestion={...sug,overridden:true,chosenAction:"ramp_fans"};
            }
          }
        }
      });

      reps = reps.filter(r=>!removeRep.has(r.taskId)).concat(addRep);
      setIncidents(incs);
      setRepairs(reps);
    },650);
    return ()=>clearInterval(h);
  },[running,backendConnected,addLog]);

  function updateIncident(node, patch){
    setIncidents(list=>list.map(i=>i.node===node && i.stage!=="resolved" ? {...i,...patch} : i));
  }
  function queueRepair(node, action, prefix=4000){
    const taskId=`rt-${prefix+stRef.current.tick}`;
    setRepairs(r=>[...r,{taskId,node,action,ticksLeft:4,effectApplied:false}]);
    return taskId;
  }
  function accept(incident) {
    if(backendConnected){ sendWS({type:"accept",incidentId:incident.id}); return; }
    const sug=incident?.suggestion; if(!sug) return;
    const taskId=queueRepair(incident.node,sug.action,4000);
    addLog("op",`SRE ACCEPTED ${sug.action}. Repair task ${taskId} queued on ${incident.node} — 4 ticks.`,incident.node);
    updateIncident(incident.node,{stage:"repairing"});
  }
  function override(incident, action) {
    if(backendConnected){ sendWS({type:"override",incidentId:incident.id,action}); return; }
    const sug=incident?.suggestion; if(!sug) return;
    addLog("op",`SRE OVERRIDE: rejected ${sug.action}, applying ${action}. Correction → KG.`,incident.node);
    recordOverrideState(sug.action,action,incident.node,stRef.current.tick);
    queueRepair(incident.node,action,5000);
    updateIncident(incident.node,{stage:"repairing",suggestion:{...sug,overridden:true,chosenAction:action}});
  }
  function escalate(incident) {
    const node=incident?.node||stRef.current.focusNode;
    if(backendConnected){ sendWS({type:"escalate",node}); return; }
    addLog("op",`SRE ESCALATED ${node} → on-call (L2). Page sent to primary + secondary.`,node);
    addChat("sys",`⚑ Escalated ${node} to on-call (L2). PagerDuty incident opened; secondary notified.`);
  }
  function cancelRepair(taskId){
    if(backendConnected){ sendWS({type:"cancel_repair",taskId}); return; }
    setRepairs(r=>r.filter(x=>x.taskId!==taskId));
    addLog("op",`SRE cancelled repair task ${taskId}.`);
  }
  function resetEpisode(gen) {
    if(backendConnected){
      sendWS({type:"reset",gen});
      sendWS({type:"set_running",running:true});
      setAgentGen(gen); setFocusNode(FAULT_NODE);
      setChat([{role:"sys",text:`Episode reset to gen-${gen}. Backend running real LLM diagnosis.`}]);
      return;
    }
    setNodes(freshNodes()); setTick(0); setIncidents([]); setRepairs([]);
    histRef.current={}; setAgentGen(gen); setRunning(true); setFocusNode(FAULT_NODE);
    setLog([{t:0,kind:"sys",text:`Episode reset — fault-injection scenario, seed 42, gen-${gen}. ${gen>=4?"KG similarity retrieval + evolved prompt active.":"Baseline agent."}`}]);
    setChat([{role:"sys",text:`Episode reset to gen-${gen}. Ask a question or type "/" for actions.`}]);
  }

  /* SRE chat handler — real LLM streaming if backend connected, scripted otherwise */
  async function handleChat(text){
    addChat("sre",text);
    const S=stRef.current;
    const node=S.focusNode;
    const incident=S.incidents.find(i=>i.node===node && i.stage!=="resolved");

    // ── Slash commands ────────────────────────────────────────────────────
    if(text.startsWith("/")){
      const [cmd] = text.split(" ");
      const spec = SLASH_COMMANDS.find(c=>c.cmd===cmd);
      if(!spec){ addChat("agent",`Unknown command ${cmd}. Type "/" to see available actions.`); return; }

      // Action commands → WS (backend) or local queue
      if(spec.kind==="action"){
        if(backendConnected){
          sendWS({type:"queue_repair",node,action:spec.action,prefix:6000});
        } else {
          const tid=queueRepair(node,spec.action,6000);
          addLog("op",`SRE via console: queued ${spec.action} on ${node} (${tid}).`,node);
          if(incident) updateIncident(node,{stage:"repairing",
            suggestion:incident.suggestion?{...incident.suggestion,chosenAction:spec.action}:undefined});
        }
        addChat("agent",`Queued ${spec.action} on ${node} — 4 ticks. Watching post-fix window.`);
        return;
      }
      if(spec.kind==="borg"){
        if(backendConnected){
          sendWS({type:"queue_repair",node,action:"restart_node",prefix:8000});
        } else {
          const tid=queueRepair(node,"restart_node",8000);
          addLog("op",`SRE via console: launched raw Borg job on ${node} (${tid}).`,node);
        }
        addChat("agent",`Borg job launched on ${node} (restart_node).`);
        return;
      }
      if(spec.kind==="escalate"){ escalate(incident||{node}); return; }
      if(cmd==="/diagnose"){
        if(!incident){ addChat("agent",`No active incident on ${node}. Telemetry nominal.`); return; }
        if(backendConnected){
          sendWS({type:"rediagnose", incidentId:incident.id});
          addChat("agent",`Re-running diagnosis on ${node}…`);
          return;
        }
        const sug=buildSuggestion(S.nodes,S.agentGen,incident.faultType,node);
        updateIncident(node,{stage:"suggested",suggestion:sug});
        addChat("agent",`Re-diagnosed ${node}: ${sug.diagnosis} → ${sug.action} (conf ${sug.conf}).`);
        return;
      }
    }

    // ── LLM stream (backend) or scripted fallback ─────────────────────────
    if(backendConnected && BACKEND_HTTP){
      const apiUrl = `${BACKEND_HTTP}/api/chat`;
      const nodeState = S.nodes.find(n=>n.id===node)||{};
      // Add streaming placeholder
      addChat("agent","▌");
      let agentText="";
      try {
        const resp = await fetch(apiUrl,{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({text,focusNode:node,incident,node:nodeState,gen:S.agentGen}),
        });
        const reader=resp.body.getReader();
        const decoder=new TextDecoder();
        while(true){
          const {done,value}=await reader.read();
          if(done) break;
          const lines=decoder.decode(value).split("\n");
          for(const line of lines){
            if(!line.startsWith("data: ")) continue;
            const raw=line.slice(6).trim();
            if(raw==="[DONE]") break;
            try{
              agentText += JSON.parse(raw).text||"";
              setChat(c=>{
                const u=[...c]; u[u.length-1]={role:"agent",text:agentText};
                return u;
              });
            } catch{}
          }
        }
        // Finalise (remove blinking cursor artefact)
        setChat(c=>{ const u=[...c]; u[u.length-1]={role:"agent",text:agentText||"…"}; return u; });
      } catch(err){
        setChat(c=>{ const u=[...c]; u[u.length-1]={role:"agent",text:`[Stream error: ${err.message}]`}; return u; });
      }
      return;
    }

    // ── Scripted fallback (demo mode, no backend) ─────────────────────────
    if(text.startsWith("/")){
      addChat("agent",askAgent({text:text.slice(1),incident,node,
        nodeState:S.nodes.find(n=>n.id===node),agentGen:S.agentGen,corrections:S.kgCorr}));
      return;
    }
    addChat("agent",askAgent({text,incident,node,
      nodeState:S.nodes.find(n=>n.id===node),agentGen:S.agentGen,corrections:S.kgCorr}));
  }

  const statusColor = {connected:T.ok, error:T.crit, reconnecting:T.warn, connecting:T.warn, demo:T.faint};
  const statusLabel = {connected:"backend ●", error:"backend ✕", reconnecting:"reconnecting…", connecting:"connecting…", demo:"demo mode"};

  function handleRunMeta(){
    if (!BACKEND_HTTP) return;
    setMetaLoading(true);
    fetch(`${BACKEND_HTTP}/api/meta`, {method:"POST"})
      .then(r=>r.json())
      .then(d=>{ setMetaResult(d); setMetaLoading(false); })
      .catch(()=>setMetaLoading(false));
  }

  const mttr = liveMetrics?.mttr ?? (agentGen >= 4 ? 3.1 : 6.8);

  function handleRun(){
    if(backendConnected){
      sendWS({type:"set_running",running:!running});
    } else {
      setRunning(r=>!r);
    }
  }

  return (
    <div style={{background:T.bg,color:T.text,minHeight:"100vh",
      fontFamily:"system-ui,-apple-system,sans-serif",padding:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
        <div style={{flex:1}}>
          <StatusBar tick={tick} running={running} agentGen={agentGen} episodes={episodes}
            corrections={kgCorr.length} onRun={handleRun}
            chatOpen={chatOpen} onChatToggle={()=>setChatOpen(o=>!o)}
            onGen0={()=>{resetEpisode(0);setTab("Observability");}}
            onGen4={()=>{resetEpisode(4);setTab("Observability");}}/>
        </div>
        <div style={{fontFamily:MONO,fontSize:10,color:statusColor[backendStatus]||T.muted,
          border:`1px solid ${statusColor[backendStatus]||T.faint}`,borderRadius:6,
          padding:"3px 8px",whiteSpace:"nowrap"}}>
          {statusLabel[backendStatus]}
        </div>
      </div>

      {/* SRE Console — floating panel anchored to navbar, zero space when closed */}
      {chatOpen && (
        <div style={{position:"fixed",top:56,right:14,width:360,zIndex:1000,
          borderRadius:10,boxShadow:"0 12px 40px rgba(0,0,0,.65)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            background:T.soft,borderRadius:"10px 10px 0 0",
            padding:"7px 12px",borderBottom:`1px solid ${T.line}`}}>
            <span style={{fontFamily:MONO,fontSize:11,fontWeight:600,color:T.agent}}>
              💬 SRE Console — {focusNode}
            </span>
            <button onClick={()=>setChatOpen(false)} style={{
              background:"transparent",border:"none",color:T.muted,
              fontSize:16,cursor:"pointer",lineHeight:1,padding:"0 2px"}}>×</button>
          </div>
          <SREChat messages={chat} onSend={handleChat} focusNode={focusNode}/>
        </div>
      )}
      <div style={{marginTop:12,marginBottom:12}}>
        <TabBar active={tab} onSelect={setTab}/>
      </div>
      {tab==="Overview"        && <OverviewTab/>}
      {tab==="Observability"   && <ObservabilityTab nodes={nodes} focusNode={focusNode} onSelect={setFocusNode}
        history={histRef.current} incidents={incidents} agentGen={agentGen} repairs={repairs} mttr={mttr}
        onAccept={accept} onOverride={override} onEscalate={escalate}
        onCancelRepair={cancelRepair} log={log} chat={chat} onChat={handleChat}/>}
      {tab==="Learning Lab"    && <LearningTab metrics={liveMetrics} metaResult={metaResult}
        onRunMeta={backendConnected ? handleRunMeta : null} metaLoading={metaLoading}/>}
      {tab==="Knowledge Graph" && <KnowledgeGraphTab corrections={kgCorr} retrievalHits={retrievalHits}
        focusNode={focusNode} hitRate={liveMetrics?.hitRate}/>}
      {tab==="Training Data"   && <TrainingDataTab pairs={pairs} priorCount={237}/>}
      <div style={{marginTop:14,fontFamily:MONO,fontSize:10,color:T.faint}}>
        INFRABRAIN · suggest-only: nothing runs without SRE approval · self-modification sandboxed to simulator
      </div>
    </div>
  );
}
