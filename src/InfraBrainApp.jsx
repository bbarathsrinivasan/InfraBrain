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
const FAULT_NODE = "R2-N5";

/* ── SIMULATOR ───────────────────────────────────────────────────────── */
function freshNodes() {
  const out = [];
  for (let r=1; r<=4; r++)
    for (let n=1; n<=8; n++)
      out.push({id:`R${r}-N${n}`, temp:56+Math.random()*10, util:52+Math.random()*28,
        fan:55+Math.random()*12, job:`job-${1000+r*8+n}(trace)`, status:"ok"});
  return out;
}
const statusOf = t => t>=88?"crit":t>=75?"warn":"ok";
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));

function stepNodes(nodes, t, repair) {
  return nodes.map(nd => {
    let {temp,util,fan} = nd;
    const isFault = nd.id===FAULT_NODE;
    const repairActive = repair?.node===nd.id && repair?.effectApplied;
    util = clamp(util+(Math.random()-.49)*4, 20, 98);
    if (isFault && t>=10 && !repairActive) fan = Math.max(14, fan-3.0);
    if (repairActive) {
      if (repair.action==="ramp_fans")       fan  = Math.min(96, fan+9);
      if (repair.action==="throttle_job")    util = Math.max(25, util-12);
      if (repair.action==="migrate_workload") util = Math.max(20, util-18);
      if (repair.action==="drain_node")      util = Math.max(5,  util-22);
    }
    if (temp>=88) util *= 0.93; // thermal throttling — deceptive symptom
    const dT = 0.085*util - 0.082*fan - 0.45 + (Math.random()-.5)*0.7;
    temp = clamp(temp+dT, 45, 104);
    return {...nd, temp, util, fan, status:statusOf(temp)};
  });
}

/* ── SHARED UI ───────────────────────────────────────────────────────── */
function Chip({label, value, color=T.text}) {
  return <div style={{background:T.panel,border:`1px solid ${T.line}`,borderRadius:6,
    padding:"4px 9px",fontFamily:MONO,fontSize:11}}>
    <span style={{color:T.faint}}>{label} </span><span style={{color}}>{value}</span>
  </div>;
}
function Panel({title, sub, children, dashed, style}) {
  return <div style={{background:T.panel,border:`1px solid ${dashed?T.faint:T.line}`,
    borderStyle:dashed?"dashed":"solid",borderRadius:10,padding:12,...style}}>
    {title && <div style={{fontSize:12.5,fontWeight:600,marginBottom:2}}>{title}</div>}
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

/* ── RACK GRID ───────────────────────────────────────────────────────── */
function RackGrid({nodes, selected, repair, onSelect}) {
  const colOf = st => st==="crit"?T.crit:st==="warn"?T.warn:T.ok;
  return <Panel title="Fleet — 4 racks × 8 nodes" sub="GPU training nodes · Alibaba trace-replay workload">
    {[1,2,3,4].map(r => <div key={r} style={{marginBottom:8}}>
      <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginBottom:3}}>RACK {r}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:4}}>
        {nodes.filter(n=>n.id.startsWith(`R${r}-`)).map(n => {
          const col=colOf(n.status), isSel=n.id===selected;
          const repairing=repair?.node===n.id && !repair?.effectApplied;
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
    <div style={{fontFamily:MONO,fontSize:10,color:T.muted,marginTop:4,display:"flex",gap:12}}>
      <span><Dot color={T.ok}/>healthy</span>
      <span><Dot color={T.warn}/>depleting</span>
      <span><Dot color={T.crit}/>critical</span>
      <span style={{color:T.agent}}>RT</span><span> = repair task</span>
    </div>
  </Panel>;
}

/* ── TELEMETRY ───────────────────────────────────────────────────────── */
function Strip({data, dataKey, color, label, domain, refs=[]}) {
  return <div style={{marginBottom:4}}>
    <div style={{fontFamily:MONO,fontSize:9.5,color:T.faint,marginBottom:1}}>{label}</div>
    <ResponsiveContainer width="100%" height={82}>
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
    sub={nd?`${nd.temp.toFixed(1)}°C · util ${nd.util.toFixed(0)}% · fan ${nd.fan.toFixed(0)}% · ${nd.job}`:"select a node"}>
    <Strip data={data} dataKey="temp" color={T.crit} label="temperature °C — warn 75° · crit 88°" domain={[45,105]} refs={[75,88]}/>
    <Strip data={data} dataKey="util" color={T.ok}   label="GPU utilization %" domain={[0,100]}/>
    <Strip data={data} dataKey="fan"  color={T.agent} label="fan speed %" domain={[0,100]}/>
  </Panel>;
}

/* ── INCIDENT PANEL ──────────────────────────────────────────────────── */
function IncidentPanel({incident, agentGen, onAccept, onOverride}) {
  const [picking,setPicking] = useState(false);
  const s=incident?.suggestion, stage=incident?.stage;
  const stageLabel = {
    analyzing:"Task agent analyzing…", suggested:"Awaiting SRE decision",
    repairing:"Repair task executing", monitoring:"Post-fix monitoring — time-to-recurrence",
    resolved:"Resolved",
  };
  return <Panel title="Incident" sub={stage?stageLabel[stage]:"Watcher quiet — no anomaly"}>
    {!incident && <div style={{fontSize:11.5,color:T.faint,fontFamily:MONO}}>
      Fault fires at t010 on R2-N5.<br/>
      Fan degradation → thermal cascade.<br/>
      Gen-0 misdiagnoses as CPU overload.<br/>Gen-4 gets it right via KG correction.
    </div>}
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
      {stage==="suggested" && !picking && <div style={{display:"flex",gap:8}}>
        <Btn color={T.ok} onClick={onAccept}>Accept & queue repair</Btn>
        <Btn color={T.kg} onClick={()=>setPicking(true)}>Override…</Btn>
      </div>}
      {stage==="suggested" && picking && <div>
        <div style={{fontFamily:MONO,fontSize:10,color:T.faint,marginBottom:5}}>
          SELECT CORRECT ACTION — writes correction to KG + exports pair
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {ACTIONS.filter(a=>a!==s.action).map(a =>
            <Btn key={a} color={T.kg} onClick={()=>{setPicking(false);onOverride(a);}}>{a}</Btn>)}
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

/* ── EVENT LOG ───────────────────────────────────────────────────────── */
function EventLog({log}) {
  const col = {sys:T.muted, watch:T.warn, agent:T.agent, op:T.kg};
  const lbl = {sys:"SYS  ", watch:"WATCH", agent:"AGENT", op:"SRE  "};
  return <Panel title="Event log" sub="watcher · task agent · SRE operator — color-coded by source" style={{flex:1}}>
    <div style={{fontFamily:MONO,fontSize:10.5,lineHeight:1.7,maxHeight:180,overflowY:"auto"}}>
      {log.map((e,i) => <div key={i} style={{color:col[e.kind]||T.muted,display:"flex",gap:6}}>
        <span style={{color:T.faint,minWidth:30}}>t{String(e.t).padStart(3,"0")}</span>
        <span style={{color:T.faint,minWidth:44}}>[{lbl[e.kind]||"SYS  "}]</span>
        <span>{e.text}</span>
      </div>)}
    </div>
  </Panel>;
}

/* ── OBSERVABILITY TAB ───────────────────────────────────────────────── */
function ObservabilityTab({nodes,selected,onSelect,history,incident,agentGen,repair,onAccept,onOverride,log}) {
  return <div style={{display:"grid",gridTemplateColumns:"300px 1fr 340px",gap:12}}>
    <RackGrid nodes={nodes} selected={selected} repair={repair} onSelect={onSelect}/>
    <Telemetry history={history} nodes={nodes} selected={selected}/>
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <IncidentPanel incident={incident} agentGen={agentGen} onAccept={onAccept} onOverride={onOverride}/>
      <EventLog log={log}/>
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

/* ── ROOT APP ────────────────────────────────────────────────────────── */
export default function InfraBrainApp() {
  const [tab,setTab]         = useState("Observability");
  const [running,setRunning] = useState(false);
  const [tick,setTick]       = useState(0);
  const [nodes,setNodes]     = useState(freshNodes);
  const [selected,setSelected] = useState(FAULT_NODE);
  const [agentGen,setAgentGen] = useState(0);
  const [incident,setIncident] = useState(null);
  const [repair,setRepair]     = useState(null);
  const [episodes,setEpisodes] = useState(37);
  const [kgCorr,setKgCorr]     = useState([]);
  const [pairs,setPairs]       = useState([]);
  const [log,setLog] = useState([{t:0,kind:"sys",text:"Simulator ready. Press RUN — fault fires at t010 on R2-N5."}]);
  const histRef = useRef({});
  const stRef   = useRef({});
  stRef.current = {nodes,incident,repair,agentGen,tick,kgCorr,pairs};

  const addLog = useCallback((kind,text) =>
    setLog(l=>[{t:stRef.current.tick,kind,text},...l].slice(0,80)),[]);

  function buildSuggestion(n, gen) {
    const nd=n.find(x=>x.id===FAULT_NODE)||{};
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

  useEffect(()=>{
    if (!running) return;
    const h = setInterval(()=>{
      const S = stRef.current;
      const t = S.tick+1;
      setTick(t);
      const next = stepNodes(S.nodes, t, S.repair);
      setNodes(next);
      next.forEach(nd=>{
        const h2=(histRef.current[nd.id]||=[]);
        h2.push({t, temp:+nd.temp.toFixed(1), util:+nd.util.toFixed(1), fan:+nd.fan.toFixed(1)});
        if(h2.length>90) h2.shift();
      });
      const fault=next.find(n=>n.id===FAULT_NODE);
      let inc=S.incident, rep=S.repair;

      // Repair countdown
      if (rep && !rep.effectApplied) {
        rep={...rep, ticksLeft:rep.ticksLeft-1};
        if (rep.ticksLeft<=0) {
          rep={...rep, effectApplied:true};
          addLog("sys",`Repair task ${rep.taskId} complete on ${rep.node} — ${rep.action} applied. Monitoring post-fix window.`);
          inc={...inc, stage:"monitoring", monitorFrom:t};
        }
        setRepair(rep);
      }
      // Watcher fires
      if (!inc && fault.temp>=75 && t>=10) {
        addLog("watch",`Watcher: ${FAULT_NODE} temp ${fault.temp.toFixed(1)}°C fan ${fault.fan.toFixed(0)}% util ${fault.util.toFixed(0)}% (z=3.4) — anomaly flagged.`);
        inc={stage:"analyzing", since:t, faultNode:FAULT_NODE};
        setSelected(FAULT_NODE);
      }
      // Agent suggestion (2 ticks after detection)
      if (inc?.stage==="analyzing" && t>=inc.since+2) {
        const sug=buildSuggestion(next, S.agentGen);
        addLog("agent",`Task agent (gen-${S.agentGen}): ${sug.diagnosis} → ${sug.action} (conf ${sug.conf}). Awaiting SRE decision.`);
        inc={...inc, stage:"suggested", suggestion:sug};
      }
      // Post-fix assessment
      if (inc?.stage==="monitoring" && rep?.effectApplied) {
        const elapsed=t-(inc.monitorFrom||0);
        if (elapsed>=6) {
          if (fault.temp<75) {
            addLog("sys",`Resolved — ${FAULT_NODE} stable 6 ticks post-fix. Time-to-recurrence: none. Episode logged.`);
            inc={stage:"resolved"};
            setRepair(null);
            setEpisodes(e=>e+1);
          } else if (fault.temp>=92) {
            const sug=inc.suggestion;
            addLog("watch",`Post-fix: temp ${fault.temp.toFixed(1)}°C — fix ineffective. Scripted operator override firing.`);
            addLog("op",`Override: rejected ${sug.action}, applying ramp_fans. Correction → KG. Pair exported.`);
            const corrId=`corr-${S.kgCorr.length+1}`;
            const cx=120+(S.kgCorr.length%4)*60, cy=290;
            setKgCorr(k=>[...k,{id:corrId,label:`override #C${k.length+1}`,kind:"correction",
              x:cx,y:cy,rejected:sug.action,applied:"ramp_fans",ctx:`R2-N5 gen-${S.agentGen}`}]);
            setPairs(p=>[...p,{id:p.length+1,ctx:`sig: temp↑/fan↓ @ R2-N5 t${t}`,
              rejected:sug.action,chosen:"ramp_fans",source:"operator_override"}]);
            setRepair({taskId:`rt-${7000+t}`,node:FAULT_NODE,action:"ramp_fans",ticksLeft:4,effectApplied:false});
            inc={...inc,stage:"repairing",suggestion:{...sug,overridden:true,chosenAction:"ramp_fans"}};
          }
        }
      }
      setIncident(inc);
    },650);
    return ()=>clearInterval(h);
  },[running,addLog]);

  function recordOverride(sug, applied) {
    const S=stRef.current;
    const corrId=`corr-${S.kgCorr.length+1}`;
    const cx=120+(S.kgCorr.length%4)*60, cy=290;
    setKgCorr(k=>[...k,{id:corrId,label:`override #C${k.length+1}`,kind:"correction",
      x:cx,y:cy,rejected:sug.action,applied,ctx:`R2-N5 gen-${S.agentGen}`}]);
    setPairs(p=>[...p,{id:p.length+1,ctx:`sig: temp↑/fan↓ @ R2-N5 t${S.tick}`,
      rejected:sug.action,chosen:applied,source:"operator_override"}]);
  }
  function accept() {
    const sug=incident?.suggestion; if(!sug) return;
    const taskId=`rt-${4000+tick}`;
    addLog("op",`SRE ACCEPTED ${sug.action}. Repair task ${taskId} queued on R2-N5 — 4 ticks.`);
    setRepair({taskId,node:FAULT_NODE,action:sug.action,ticksLeft:4,effectApplied:false});
    setIncident({...incident,stage:"repairing"});
  }
  function override(action) {
    const sug=incident?.suggestion;
    addLog("op",`SRE OVERRIDE: rejected ${sug.action}, applying ${action}. Correction → KG.`);
    recordOverride(sug,action);
    setRepair({taskId:`rt-${5000+tick}`,node:FAULT_NODE,action,ticksLeft:4,effectApplied:false});
    setIncident({...incident,stage:"repairing",suggestion:{...sug,overridden:true,chosenAction:action}});
  }
  function resetEpisode(gen) {
    setNodes(freshNodes()); setTick(0); setIncident(null); setRepair(null);
    histRef.current={}; setAgentGen(gen); setRunning(true);
    setLog([{t:0,kind:"sys",text:`Episode reset — fan-degradation scenario, seed 42, gen-${gen}. ${gen>=4?"KG similarity retrieval + evolved prompt active.":"Baseline agent."}`}]);
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
      {tab==="Observability"  && <ObservabilityTab nodes={nodes} selected={selected} onSelect={setSelected}
        history={histRef.current} incident={incident} agentGen={agentGen} repair={repair}
        onAccept={accept} onOverride={override} log={log}/>}
      {tab==="Learning Lab"   && <LearningTab/>}
      {tab==="Knowledge Graph"&& <KnowledgeGraphTab corrections={kgCorr}/>}
      {tab==="Training Data"  && <TrainingDataTab pairs={pairs}/>}
      <div style={{marginTop:14,fontFamily:MONO,fontSize:10,color:T.faint}}>
        INFRABRAIN · all data synthetic · suggest-only: nothing runs without SRE approval · self-modification sandboxed to simulator
      </div>
    </div>
  );
}
