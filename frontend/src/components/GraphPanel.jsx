import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";

const PALETTE = [
  "#3b82f6", // blue
  "#a855f7", // purple
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

export default function GraphPanel() {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const fgRef = useRef(null);

  useEffect(() => {
    fetch("http://127.0.0.1:8000/api/sot/graph")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setGraph)
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  useEffect(() => {
    function onResize() {
      setSize({ w: window.innerWidth, h: window.innerHeight });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Stable color per course
  const courseColor = useMemo(() => {
    const map = {};
    if (graph?.nodes) {
      const seen = [];
      for (const n of graph.nodes) {
        const c = n.course ?? "(none)";
        if (!seen.includes(c)) seen.push(c);
        map[c] = PALETTE[seen.indexOf(c) % PALETTE.length];
      }
    }
    return map;
  }, [graph]);

  // Memoize a *single* graph data object so the simulation isn't restarted on
  // every render (selection, hover, etc.). Without this the layout jumps.
  const graphData = useMemo(
    () => (graph ? { nodes: graph.nodes, links: graph.links } : { nodes: [], links: [] }),
    [graph],
  );

  if (error) {
    return (
      <Container>
        <div style={{ color: "#ef4444" }}>{error}</div>
      </Container>
    );
  }
  if (!graph) {
    return (
      <Container>
        <div style={{ color: "rgba(255,255,255,0.5)" }}>Loading graph…</div>
      </Container>
    );
  }
  if (graph.nodes.length === 0) {
    return (
      <Container>
        <div style={{ color: "rgba(255,255,255,0.5)" }}>
          SOT is empty. Switch to Ingest to add a lesson.
        </div>
      </Container>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "black",
        zIndex: 5,
      }}
    >
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={size.w}
        height={size.h}
        backgroundColor="#000"
        nodeId="id"
        nodeRelSize={5}
        nodeLabel={(n) => `${n.course} · w${n.week} — ${n.lesson}`}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const isSelected = selected?.id === node.id;
          const r = isSelected ? 8 : 6;
          const color = courseColor[node.course ?? "(none)"] ?? "#94a3b8";

          // node disc with glow
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.shadowBlur = isSelected ? 24 : 8;
          ctx.shadowColor = color;
          ctx.fill();
          ctx.shadowBlur = 0;

          // label below
          const fontSize = Math.max(9, 11 / globalScale);
          ctx.font = `${isSelected ? 600 : 400} ${fontSize}px system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = isSelected
            ? "#ffffff"
            : "rgba(255,255,255,0.7)";
          const label = node.lesson ?? "";
          ctx.fillText(
            label.length > 32 ? label.slice(0, 31) + "…" : label,
            node.x,
            node.y + r + 2,
          );
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkColor={() => "rgba(255,255,255,0.18)"}
        linkWidth={(l) => Math.min(3, 0.8 + (l.weight ?? 1) * 0.6)}
        linkLabel={(l) =>
          `shared: ${(l.shared ?? []).join(", ")}`
        }
        cooldownTicks={120}
        onNodeClick={(node) => {
          setSelected(node);
          if (fgRef.current) {
            fgRef.current.centerAt(node.x, node.y, 600);
            fgRef.current.zoom(2, 600);
          }
        }}
        onBackgroundClick={() => setSelected(null)}
      />

      <Legend courseColor={courseColor} count={graph.nodes.length} linkCount={graph.links.length} />
      {selected && <DetailsPanel node={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Legend({ courseColor, count, linkCount }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 24,
        left: 24,
        background: "rgba(8,10,16,0.7)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        padding: "10px 12px",
        backdropFilter: "blur(6px)",
        zIndex: 10,
        fontSize: 12,
        color: "rgba(255,255,255,0.75)",
      }}
    >
      <div style={{ marginBottom: 6, color: "rgba(255,255,255,0.5)", fontSize: 11 }}>
        {count} lessons · {linkCount} links
      </div>
      {Object.entries(courseColor).map(([course, color]) => (
        <div key={course} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: color,
              display: "inline-block",
            }}
          />
          {course}
        </div>
      ))}
    </div>
  );
}

function DetailsPanel({ node, onClose }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        right: 24,
        width: 360,
        maxHeight: "70vh",
        background: "rgba(8,10,16,0.85)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 10,
        padding: 16,
        backdropFilter: "blur(8px)",
        zIndex: 10,
        color: "white",
        fontSize: 13,
        lineHeight: 1.5,
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "rgba(255,255,255,0.5)",
          }}
        >
          {node.course} · week {node.week}
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.55)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        {node.lesson}
      </div>
      {node.summary && (
        <div style={{ color: "rgba(255,255,255,0.85)", marginBottom: 10 }}>
          {node.summary}
        </div>
      )}
      {node.key_concepts?.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "rgba(255,255,255,0.5)",
              marginBottom: 4,
            }}
          >
            key concepts
          </div>
          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 12 }}>
            {node.key_concepts.join(" · ")}
          </div>
        </div>
      )}
    </div>
  );
}

function Container({ children }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        paddingTop: 80,
        paddingLeft: 24,
        zIndex: 5,
      }}
    >
      {children}
    </div>
  );
}
