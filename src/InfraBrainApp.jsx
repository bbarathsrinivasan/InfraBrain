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
const OVERRIDE_DATA = Array.from({length:40},(_,i)=>({
  ep:i+1, rate:Math.max(4,+(78-i*1.9+Math.sin(i*1.7)*7).toFixed(1))
}));
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

const KG_NODES = [
  {id:"s1",label:"temp spike",   kind:"symptom", x:55, y:50 },
  {id:"s2",label:"util drop",    kind:"symptom", x:52, y:120},
  {id:"s3",label:"fan% fall",    kind:"symptom", x:55, y:190},
  {id:"s4",label:"dark node",    kind:"symptom", x:52, y:255},
  {id:"c1",label:"fan failure",  kind:"cause",   x:185,y:40 },
  {id:"c2",label:"cpu overload", kind:"cause",   x:188,y:110},
  {id:"c3",label:"mem leak",     kind:"cause",   x:185,y:180},
  {id:"c4",label:"node dead",    kind:"cause",   x:188,y:250},
  {id:"a1",label:"ramp_fans",    kind:"action",  x:315,y:50 },
  {id:"a2",label:"throttle_job", kind:"action",  x:318,y:120},
  {id:"a3",label:"migrate",      kind:"action",  x:315,y:190},
  {id:"a4",label:"drain_node",   kind:"action",  x:318,y:255},
];
const KG_SEED_EDGES = [
  ["s1","c1"],["s1","c2"],["s2","c2"],["s3","c1"],["s4","c4"],
  ["c1","a1"],["c2","a2"],["c3","a3"],["c4","a4"],
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
function Panel({title, sub, children, dashed, style, right}) {
  return <div style={{background:T.panel,border:`1px solid ${dashed?T.faint:T.line}`,
    borderStyle:dashed?"dashed":"solid",borderRadius:10,padding:12,...style}}>
    {(title||right) && <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:sub?2:0}}>
      {title && <div style={{fontSize:12.5,fontWeight:600}}>{title}</div>}
      <div style={{flex:1}}/>{right}
    </div>}
    {sub   && <div style={{fontFamily:MONO,fontSize:10,color:T.muted,marginBottom:8}}>{sub}</div>}
    {children}
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
function StatusBar({tick,running,agentGen,episodes,corrections,onRun,onGen0,onGen4}) {
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
  </div>;
}

/* ── TAB BAR ─────────────────────────────────────────────────────────── */
const TABS = ["Observability","Learning Lab","Knowledge Graph","Training Data"];
const TAB_HINTS = {
  "Observability":    "real-time fleet view — watch fault develop, agent suggest, override teach the system",
  "Learning Lab":     "offline results — both curves on held-out scenarios the agent never trained on",
  "Knowledge Graph":  "non-parametric memory — amber nodes are operator corrections, auditable and reversible",
  "Training Data":    "the data flywheel — preference pairs ready for DPO · simulator ready for GRPO",
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
function FleetHealthStrip({nodes, incidents, repairs, agentGen}) {
  const ok  = nodes.filter(n=>n.status==="ok").length;
  const wn  = nodes.filter(n=>n.status==="warn").length;
  const cr  = nodes.filter(n=>n.status==="crit").length;
  const active = incidents.filter(i=>i.stage!=="resolved").length;
  const inFlight = repairs.length;
  const hottest = nodes.reduce((a,b)=>b.temp>a.temp?b:a, nodes[0]);
  const mttr = agentGen>=4 ? "3.1" : "6.8";
  return <Panel style={{padding:"10px 14px"}}>
    <div style={{display:"flex",alignItems:"center",gap:22,flexWrap:"wrap"}}>
      <HealthStat label="HEALTHY" value={ok} color={T.ok}/>
      <HealthStat label="DEPLETING" value={wn} color={T.warn}/>
      <HealthStat label="CRITICAL" value={cr} color={T.crit}/>
      <div style={{width:1,height:34,background:T.line}}/>
      <HealthStat label="ACTIVE INCIDENTS" value={active} color={active?T.crit:T.muted}/>
      <HealthStat label="RT JOBS IN FLIGHT" value={inFlight} color={inFlight?T.agent:T.muted}/>
      <HealthStat label="MTTR (ticks)" value={mttr} color={T.text}/>
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
function RepairQueue({repairs, onCancel}) {
  return <Panel title="Repair task queue" sub="Borg-style RT jobs · suggest-only: queued by SRE, never autonomous">
    {repairs.length===0 && <div style={{fontFamily:MONO,fontSize:11,color:T.faint}}>
      No repair tasks in flight. Accept an incident or use /borg to queue one.
    </div>}
    <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:150,overflowY:"auto"}}>
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
function IncidentPanel({incident, agentGen, onAccept, onOverride, onEscalate}) {
  const [picking,setPicking] = useState(false);
  const s=incident?.suggestion, stage=incident?.stage;
  const stageLabel = {
    analyzing:"Task agent analyzing…", suggested:"Awaiting SRE decision",
    repairing:"Repair task executing", monitoring:"Post-fix monitoring — time-to-recurrence",
    resolved:"Resolved",
  };
  return <Panel title={incident?`Incident — ${incident.node}`:"Incident"}
    sub={stage?stageLabel[stage]:"Watcher quiet — no anomaly on focused node"}
    right={incident && <Btn color={T.crit} onClick={()=>onEscalate(incident)} style={{padding:"3px 9px"}}>⚑ Escalate</Btn>}>
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
function BlastRunbook({incident}) {
  if(!incident) return <Panel title="Blast radius & runbook" sub="focus an incident to see impact + playbook">
    <div style={{fontFamily:MONO,fontSize:11,color:T.faint}}>No incident focused.</div>
  </Panel>;
  const b = blastRadius(incident.node);
  const rb = RUNBOOKS[incident.faultType] || RUNBOOKS.default;
  return <Panel title="Blast radius & runbook" sub={`impact of ${incident.node} · tenant ${b.tenant}`}>
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
function EventLog({log, focusNode}) {
  const col = {sys:T.muted, watch:T.warn, agent:T.agent, op:T.kg};
  const lbl = {sys:"SYS  ", watch:"WATCH", agent:"AGENT", op:"SRE  "};
  const shown = focusNode ? log.filter(e=>!e.node || e.node===focusNode) : log;
  return <Panel title="Event log" sub={focusNode?`filtered → ${focusNode} · watcher · agent · SRE`:"watcher · task agent · SRE operator"} style={{flex:1}}>
    <div style={{fontFamily:MONO,fontSize:10.5,lineHeight:1.7,maxHeight:150,overflowY:"auto"}}>
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
  return <div style={{display:"flex",flexDirection:"column",gap:12}}>
    <FleetHealthStrip nodes={p.nodes} incidents={p.incidents} repairs={p.repairs} agentGen={p.agentGen}/>
    <FocusSwitcher incidents={p.incidents} focusNode={p.focusNode} onFocus={p.onSelect}/>
    <div style={{display:"grid",gridTemplateColumns:"300px 1fr 360px",gap:12,alignItems:"start"}}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <RackGrid nodes={p.nodes} selected={p.focusNode} repairs={p.repairs} onSelect={p.onSelect}/>
        <RepairQueue repairs={p.repairs} onCancel={p.onCancelRepair}/>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Telemetry history={p.history} nodes={p.nodes} selected={p.focusNode}/>
        <BlastRunbook incident={focusIncident}/>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <IncidentPanel incident={focusIncident} agentGen={p.agentGen}
          onAccept={p.onAccept} onOverride={p.onOverride} onEscalate={p.onEscalate}/>
        <EventLog log={p.log} focusNode={p.focusNode}/>
        <SREChat messages={p.chat} onSend={p.onChat} focusNode={p.focusNode}/>
      </div>
    </div>
  </div>;
}

/* ── LEARNING LAB TAB ────────────────────────────────────────────────── */
function LearningTab() {
  const [showDiff,setShowDiff] = useState(false);
  const tk = {fill:T.faint, fontSize:9};
  const tt = {contentStyle:{background:T.soft,border:`1px solid ${T.line}`,fontSize:11}};
  return <div style={{display:"flex",flexDirection:"column",gap:12}}>
    <div style={{fontFamily:MONO,fontSize:10,color:T.faint,letterSpacing:2}}>
      LEARNING PLANE — OFFLINE · SANDBOXED · ALL METRICS ON HELD-OUT SCENARIOS
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Panel title="Override rate ↓ — KG institutional memory"
        sub="headline metric · falls as KG corrections accumulate · same scenario family, new seeds">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={OVERRIDE_DATA} margin={{top:8,right:12,bottom:8,left:-18}}>
            <XAxis dataKey="ep" tick={tk} stroke={T.line}/>
            <YAxis tick={tk} stroke={T.line} unit="%"/>
            <Tooltip {...tt}/>
            <Line dataKey="rate" stroke={T.kg} dot={false} strokeWidth={2}/>
          </LineChart>
        </ResponsiveContainer>
        <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,marginTop:4}}>
          Each override writes a correction to the KG. Future incidents with the same symptom signature retrieve it — agent stops making the same mistake.
        </div>
      </Panel>
      <Panel title="Composite score ↑ — meta-agent evolution"
        sub="train vs held-out · split by scenario family · held-out proves generalization not memorisation">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={GEN_DATA} margin={{top:8,right:12,bottom:8,left:-18}}>
            <XAxis dataKey="gen" tick={tk} stroke={T.line}/>
            <YAxis tick={tk} stroke={T.line} domain={[0,.85]}/>
            <Tooltip {...tt}/>
            <Legend wrapperStyle={{fontSize:10,fontFamily:MONO}}/>
            <Line dataKey="train"   stroke={T.agent} dot strokeWidth={2}/>
            <Line dataKey="holdout" stroke={T.ok}    dot strokeWidth={2}/>
          </LineChart>
        </ResponsiveContainer>
        <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
          <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,flex:1}}>
            Both lines rise → meta-agent improving diagnosis, not memorising scenarios.
          </div>
          <Btn color={T.agent} onClick={()=>setShowDiff(s=>!s)}>
            {showDiff?"Hide":"Show"} gen-3→4 diff
          </Btn>
        </div>
      </Panel>
    </div>
    {showDiff && <Panel title="Gen-3 → gen-4: what the meta agent wrote"
      sub="machine-generated · one diff per generation · kept only if held-out score improved">
      <pre style={{fontFamily:MONO,fontSize:11,lineHeight:1.6,background:"#0A0D11",
        border:`1px solid ${T.line}`,borderRadius:6,padding:12,overflowX:"auto"}}>
        {META_DIFF.split("\n").map((l,i)=><div key={i} style={{
          color:l.startsWith("+")?T.ok:l.startsWith("-")?T.crit:l.startsWith("@")?T.agent:T.muted
        }}>{l}</div>)}
      </pre>
      <div style={{fontFamily:MONO,fontSize:10.5,color:T.muted,marginTop:6}}>
        Meta agent identified exact-label KG lookups missing near-miss signatures. Rewrote retrieval and ranked corrections above seed knowledge. Held-out jumped 0.55 → 0.61.
      </div>
    </Panel>}
    <Panel title="Future work — DPO / GRPO" sub="preference pairs accumulate every episode · architecture is ready" dashed>
      <div style={{fontFamily:MONO,fontSize:11,color:T.muted,lineHeight:1.9}}>
        <span style={{color:T.ok}}>What we have:</span> closed loop — KG memory + meta-agent evolution, both on held-out.<br/>
        <span style={{color:T.kg}}>What the data enables:</span> DPO on preference pairs (see Training Data tab).<br/>
        <span style={{color:T.agent}}>After DPO:</span> GRPO against the simulator's composite reward. The simulator IS the RL environment.
      </div>
    </Panel>
  </div>;
}

/* ── KNOWLEDGE GRAPH TAB ─────────────────────────────────────────────── */
function KnowledgeGraphTab({corrections}) {
  const [sel,setSel] = useState(null);
  const kindColor = {symptom:T.warn, cause:T.crit, action:T.ok, correction:T.kg};
  const kindLabel = {symptom:"Symptom", cause:"Root cause", action:"Remediation", correction:"Operator correction"};
  const allNodes = [...KG_NODES, ...corrections];
  const corrEdges = corrections.flatMap(c=>[{from:"s1",to:c.id,kind:"correction"},{from:c.id,to:"a1",kind:"correction"}]);
  const allEdges = [...KG_SEED_EDGES.map(([f,t])=>({from:f,to:t,kind:"seed"})), ...corrEdges];
  const selNode = allNodes.find(n=>n.id===sel);
  return <div style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:12}}>
    <Panel title="Knowledge graph"
      sub={`${allNodes.length} nodes · ${allEdges.length} edges · amber = operator corrections — click any node`}>
      <svg viewBox="0 0 420 320" style={{width:"100%",height:360}}>
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
          return <g key={n.id} onClick={()=>setSel(isSel?null:n.id)} style={{cursor:"pointer"}}>
            <circle cx={n.x} cy={n.y} r={n.kind==="correction"?7:6}
              fill={col} fillOpacity={isSel?1:.8}
              stroke={isSel?T.text:col} strokeWidth={isSel?2:0}/>
            <text x={n.x} y={n.y-9} textAnchor="middle"
              fill={isSel?T.text:T.muted} fontSize={8} fontFamily={MONO}>{n.label}</text>
          </g>;
        })}
      </svg>
      <div style={{fontFamily:MONO,fontSize:10,color:T.muted,display:"flex",gap:14,marginTop:4}}>
        {Object.entries(kindLabel).map(([k,l])=><span key={k}><Dot color={kindColor[k]}/>{l}</span>)}
      </div>
    </Panel>
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
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
    </div>
  </div>;
}

/* ── TRAINING DATA TAB ───────────────────────────────────────────────── */
function TrainingDataTab({pairs}) {
  const PRIOR=237, total=PRIOR+pairs.length;
  const SCHEMA=`{\n  "id":       1,\n  "context":  "sig: temp↑/fan↓ @ R2-N5 t042",\n  "rejected": "throttle_job",\n  "chosen":   "ramp_fans",\n  "source":   "operator_override"\n}`;
  const PHASES = [
    {n:"01",title:"Shadow mode",color:T.agent,
      body:"Seed KG from postmortems and playbooks. Run in shadow mode against fault-injection tooling — accumulate corrections before touching live SREs."},
    {n:"02",title:"Suggest-only with SREs",color:T.ok,
      body:"Agent suggests, SRE decides. Every override writes to KG and exports a preference pair. Override rate falls as KG grows. This demo IS phase 02."},
    {n:"03",title:"DPO / GRPO training",color:T.kg,
      body:"Finetune a small model (3–8B, LoRA) via DPO on accumulated pairs. Gate on held-out regression. GRPO against simulator reward is the next step."},
  ];
  return <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
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
      <Panel title="Pair schema — JSONL export format">
        <pre style={{fontFamily:MONO,fontSize:11,lineHeight:1.7,background:"#0A0D11",
          border:`1px solid ${T.line}`,borderRadius:6,padding:10,color:T.muted}}>{SCHEMA}</pre>
        <div style={{marginTop:8}}><Btn disabled color={T.faint}>Export JSONL — future work: DPO / GRPO</Btn></div>
      </Panel>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <Panel title="Cold start → data flywheel" sub="three-phase production deployment">
        {PHASES.map(p => <div key={p.n} style={{borderLeft:`3px solid ${p.color}`,paddingLeft:12,marginBottom:16}}>
          <div style={{fontFamily:MONO,fontSize:9,color:p.color,letterSpacing:2,marginBottom:2}}>PHASE {p.n}</div>
          <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>{p.title}</div>
          <div style={{fontSize:11.5,color:T.muted}}>{p.body}</div>
        </div>)}
        <div style={{fontFamily:MONO,fontSize:10.5,color:T.faint,borderTop:`1px solid ${T.line}`,paddingTop:10}}>
          The simulator plays the role of the real SRE environment — same architecture, compressed clock.
        </div>
      </Panel>
      <Panel title="Why not RL now?" dashed>
        <div style={{fontFamily:MONO,fontSize:11,color:T.muted,lineHeight:1.9}}>
          <div><span style={{color:T.ok}}>What we have:</span> closed loop — KG + meta-agent evolution on held-out scenarios.</div>
          <div style={{marginTop:6}}><span style={{color:T.kg}}>What the data enables:</span> DPO on these pairs. Same architecture.</div>
          <div style={{marginTop:6}}><span style={{color:T.agent}}>After DPO:</span> GRPO against simulator reward. Nothing new to build.</div>
          <div style={{marginTop:6,color:T.faint}}>Two days → not enough episodes for stable RL. Preference pairs are the honest bridge.</div>
        </div>
      </Panel>
    </div>
  </div>;
}

/* ── AGENT RESPONSE (scripted now · swap in a real LLM later) ─────────── */
/*
 * To wire a real model later, replace the body of askAgent with an async
 * fetch to your backend / Anthropic API and return the completion string.
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
export default function InfraBrainApp() {
  const [tab,setTab]         = useState("Observability");
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
  const histRef = useRef({});
  const stRef   = useRef({});
  stRef.current = {nodes,incidents,repairs,agentGen,tick,kgCorr,pairs,focusNode};

  const addLog = useCallback((kind,text,node) =>
    setLog(l=>[{t:stRef.current.tick,kind,text,node},...l].slice(0,90)),[]);
  const addChat = useCallback((role,text) =>
    setChat(c=>[...c,{role,text}].slice(-60)),[]);

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
    if (!running) return;
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
  },[running,addLog]);

  function updateIncident(node, patch){
    setIncidents(list=>list.map(i=>i.node===node && i.stage!=="resolved" ? {...i,...patch} : i));
  }
  function queueRepair(node, action, prefix=4000){
    const taskId=`rt-${prefix+stRef.current.tick}`;
    setRepairs(r=>[...r,{taskId,node,action,ticksLeft:4,effectApplied:false}]);
    return taskId;
  }
  function accept(incident) {
    const sug=incident?.suggestion; if(!sug) return;
    const taskId=queueRepair(incident.node,sug.action,4000);
    addLog("op",`SRE ACCEPTED ${sug.action}. Repair task ${taskId} queued on ${incident.node} — 4 ticks.`,incident.node);
    updateIncident(incident.node,{stage:"repairing"});
  }
  function override(incident, action) {
    const sug=incident?.suggestion; if(!sug) return;
    addLog("op",`SRE OVERRIDE: rejected ${sug.action}, applying ${action}. Correction → KG.`,incident.node);
    recordOverrideState(sug.action,action,incident.node,stRef.current.tick);
    queueRepair(incident.node,action,5000);
    updateIncident(incident.node,{stage:"repairing",suggestion:{...sug,overridden:true,chosenAction:action}});
  }
  function escalate(incident) {
    const node=incident?.node||stRef.current.focusNode;
    addLog("op",`SRE ESCALATED ${node} → on-call (L2). Page sent to primary + secondary.`,node);
    addChat("sys",`⚑ Escalated ${node} to on-call (L2). PagerDuty incident opened; secondary notified.`);
  }
  function cancelRepair(taskId){
    setRepairs(r=>r.filter(x=>x.taskId!==taskId));
    addLog("op",`SRE cancelled repair task ${taskId}.`);
  }
  function resetEpisode(gen) {
    setNodes(freshNodes()); setTick(0); setIncidents([]); setRepairs([]);
    histRef.current={}; setAgentGen(gen); setRunning(true); setFocusNode(FAULT_NODE);
    setLog([{t:0,kind:"sys",text:`Episode reset — fault-injection scenario, seed 42, gen-${gen}. ${gen>=4?"KG similarity retrieval + evolved prompt active.":"Baseline agent."}`}]);
    setChat([{role:"sys",text:`Episode reset to gen-${gen}. Ask a question or type "/" for actions.`}]);
  }

  /* SRE chat handler — routes slash commands to actions, else asks the agent */
  function handleChat(text){
    addChat("sre",text);
    const S=stRef.current;
    const node=S.focusNode;
    const incident=S.incidents.find(i=>i.node===node && i.stage!=="resolved");
    if(text.startsWith("/")){
      const [cmd] = text.split(" ");
      const spec = SLASH_COMMANDS.find(c=>c.cmd===cmd);
      if(!spec){ addChat("agent",`Unknown command ${cmd}. Type "/" to see available actions.`); return; }
      if(spec.kind==="action"){
        const tid=queueRepair(node,spec.action,6000);
        addLog("op",`SRE via console: queued ${spec.action} on ${node} (${tid}).`,node);
        if(incident) updateIncident(node,{stage:"repairing",
          suggestion:incident.suggestion?{...incident.suggestion,chosenAction:spec.action}:undefined});
        addChat("agent",`Queued ${spec.action} on ${node} — repair task ${tid}, 4 ticks. Watching post-fix window.`);
        return;
      }
      if(spec.kind==="borg"){
        const tid=queueRepair(node,"restart_node",8000);
        addLog("op",`SRE via console: launched raw Borg job on ${node} (${tid}).`,node);
        addChat("agent",`Borg job ${tid} launched on ${node} (restart_node). Use /ramp_fans, /migrate, etc. for a specific action.`);
        return;
      }
      if(spec.kind==="escalate"){ escalate(incident||{node}); return; }
      if(cmd==="/diagnose"){
        if(!incident){ addChat("agent",`No active incident on ${node}. Telemetry nominal — nothing to diagnose.`); return; }
        const sug=buildSuggestion(S.nodes,S.agentGen,incident.faultType,node);
        updateIncident(node,{stage:"suggested",suggestion:sug});
        addChat("agent",`Re-diagnosed ${node}: ${sug.diagnosis} → ${sug.action} (conf ${sug.conf}).`);
        return;
      }
      // query-type: /explain /history /status
      addChat("agent",askAgent({text:cmd.slice(1),incident,node,
        nodeState:S.nodes.find(n=>n.id===node),agentGen:S.agentGen,corrections:S.kgCorr}));
      return;
    }
    // free-text question → agent
    addChat("agent",askAgent({text,incident,node,
      nodeState:S.nodes.find(n=>n.id===node),agentGen:S.agentGen,corrections:S.kgCorr}));
  }

  return (
    <div style={{background:T.bg,color:T.text,minHeight:"100vh",
      fontFamily:"system-ui,-apple-system,sans-serif",padding:14}}>
      <StatusBar tick={tick} running={running} agentGen={agentGen} episodes={episodes}
        corrections={kgCorr.length} onRun={()=>setRunning(r=>!r)}
        onGen0={()=>{resetEpisode(0);setTab("Observability");}}
        onGen4={()=>{resetEpisode(4);setTab("Observability");}}/>
      <div style={{marginTop:12,marginBottom:12}}>
        <TabBar active={tab} onSelect={setTab}/>
      </div>
      {tab==="Observability"  && <ObservabilityTab nodes={nodes} focusNode={focusNode} onSelect={setFocusNode}
        history={histRef.current} incidents={incidents} agentGen={agentGen} repairs={repairs}
        onAccept={accept} onOverride={override} onEscalate={escalate}
        onCancelRepair={cancelRepair} log={log} chat={chat} onChat={handleChat}/>}
      {tab==="Learning Lab"   && <LearningTab/>}
      {tab==="Knowledge Graph"&& <KnowledgeGraphTab corrections={kgCorr}/>}
      {tab==="Training Data"  && <TrainingDataTab pairs={pairs}/>}
      <div style={{marginTop:14,fontFamily:MONO,fontSize:10,color:T.faint}}>
        INFRABRAIN · all data synthetic · suggest-only: nothing runs without SRE approval · self-modification sandboxed to simulator
      </div>
    </div>
  );
}
