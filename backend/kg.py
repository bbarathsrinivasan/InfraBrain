"""
Knowledge graph — SQLite-backed, non-parametric.
Corrections: permanent records of operator disagreements.
Pairs:        DPO-ready preference pairs.
Traces:       episode-level telemetry for meta-agent input.

No vector DB required — signature similarity via keyword-Jaccard at this scale.
Swap retrieve_similar() for pgvector or a real embedding later.
"""
import sqlite3
import time
import os
from typing import List

DB_PATH = os.path.join(os.path.dirname(__file__), "infrabrain.db")


def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS corrections (
            id          TEXT PRIMARY KEY,
            signature   TEXT NOT NULL,
            rejected    TEXT NOT NULL,
            applied     TEXT NOT NULL,
            context     TEXT,
            source      TEXT DEFAULT 'operator_override',
            created_at  REAL
        );
        CREATE TABLE IF NOT EXISTS pairs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ctx         TEXT NOT NULL,
            rejected    TEXT NOT NULL,
            chosen      TEXT NOT NULL,
            source      TEXT DEFAULT 'operator_override',
            created_at  REAL
        );
        CREATE TABLE IF NOT EXISTS traces (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            episode     INTEGER,
            t           INTEGER,
            node        TEXT,
            fault_type  TEXT,
            diagnosis   TEXT,
            suggested   TEXT,
            sre_action  TEXT,
            outcome     TEXT,
            composite   REAL,
            mttr        REAL,
            created_at  REAL
        );
        CREATE TABLE IF NOT EXISTS kg_doc_nodes (
            id          TEXT PRIMARY KEY,
            label       TEXT NOT NULL,
            kind        TEXT NOT NULL,
            description TEXT,
            source      TEXT,
            created_at  REAL
        );
        CREATE TABLE IF NOT EXISTS kg_doc_edges (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id     TEXT NOT NULL,
            to_id       TEXT NOT NULL,
            label       TEXT,
            source      TEXT,
            created_at  REAL
        );
    """)
    conn.commit()
    conn.close()
    _migrate_traces_mttr()


def _migrate_traces_mttr():
    conn = sqlite3.connect(DB_PATH)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(traces)").fetchall()}
    if "mttr" not in cols:
        conn.execute("ALTER TABLE traces ADD COLUMN mttr REAL")
        conn.commit()
    conn.close()


# ── Corrections ───────────────────────────────────────────────────────────

def add_correction(c: dict):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR REPLACE INTO corrections(id,signature,rejected,applied,context,source,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (c["id"], c["signature"], c["rejected"], c["applied"],
         c.get("context", ""), c.get("source", "operator_override"), time.time())
    )
    conn.commit(); conn.close()


def get_corrections() -> List[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,signature,rejected,applied,context,source FROM corrections ORDER BY created_at"
    ).fetchall()
    conn.close()
    return [{"id": r[0], "signature": r[1], "rejected": r[2],
             "applied": r[3], "context": r[4], "source": r[5]} for r in rows]


def retrieve_similar(signature: str, k: int = 5) -> List[dict]:
    """
    Keyword-Jaccard similarity retrieval — no embedding API needed.
    Corrections ranked above seeds; similarity in [0,1].
    Replace with pgvector + sentence-transformers for production.
    """
    corrections = get_corrections()
    if not corrections:
        return []

    def tokenise(s: str) -> set:
        return set(
            s.lower()
             .replace("↑", " up ")
             .replace("↓", " down ")
             .replace("/", " ")
             .replace("@", " ")
             .split()
        )

    sig_tok = tokenise(signature)
    scored = []
    for corr in corrections:
        c_tok = tokenise(corr["signature"])
        union = sig_tok | c_tok
        sim = len(sig_tok & c_tok) / len(union) if union else 0.0
        scored.append({"correction": corr, "sim": round(sim, 3)})

    scored.sort(key=lambda x: -x["sim"])
    return scored[:k]


# ── Preference pairs ───────────────────────────────────────────────────────

def add_pair(p: dict):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO pairs(ctx,rejected,chosen,source,created_at) VALUES(?,?,?,?,?)",
        (p["ctx"], p["rejected"], p["chosen"], p.get("source", "operator_override"), time.time())
    )
    conn.commit(); conn.close()


def get_pairs() -> List[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,ctx,rejected,chosen,source FROM pairs ORDER BY id"
    ).fetchall()
    conn.close()
    return [{"id": r[0], "ctx": r[1], "rejected": r[2], "chosen": r[3], "source": r[4]} for r in rows]


# ── Document-ingested KG nodes/edges ──────────────────────────────────────

def add_doc_node(node: dict):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR REPLACE INTO kg_doc_nodes(id,label,kind,description,source,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (node["id"], node["label"], node.get("kind","symptom"),
         node.get("description",""), node.get("source",""), time.time())
    )
    conn.commit(); conn.close()


def add_doc_edge(edge: dict, source: str = ""):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO kg_doc_edges(from_id,to_id,label,source,created_at) VALUES(?,?,?,?,?)",
        (edge["from_id"], edge["to_id"], edge.get("label",""), source, time.time())
    )
    conn.commit(); conn.close()


def get_doc_nodes() -> List[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,label,kind,description,source FROM kg_doc_nodes ORDER BY created_at"
    ).fetchall()
    conn.close()
    return [{"id":r[0],"label":r[1],"kind":r[2],"description":r[3],"source":r[4]} for r in rows]


def get_doc_edges() -> List[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,from_id,to_id,label,source FROM kg_doc_edges ORDER BY id"
    ).fetchall()
    conn.close()
    return [{"id":r[0],"from_id":r[1],"to_id":r[2],"label":r[3],"source":r[4]} for r in rows]


# ── Episode traces ─────────────────────────────────────────────────────────

def add_trace(trace: dict):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO traces(episode,t,node,fault_type,diagnosis,suggested,sre_action,outcome,composite,mttr,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (trace.get("episode"), trace.get("t"), trace.get("node"), trace.get("faultType"),
         trace.get("diagnosis"), trace.get("suggested"), trace.get("sreAction"),
         trace.get("outcome"), trace.get("composite", 0.0), trace.get("mttr"), time.time())
    )
    conn.commit(); conn.close()


def get_traces(limit: int = 50) -> List[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,episode,t,node,fault_type,diagnosis,suggested,sre_action,outcome,composite,mttr "
        "FROM traces ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    keys = ["id","episode","t","node","faultType","diagnosis","suggested","sreAction","outcome","composite","mttr"]
    return [dict(zip(keys, r)) for r in rows]
