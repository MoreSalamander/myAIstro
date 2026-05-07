import { useEffect, useRef } from "react";

// The pipeline shape is fixed: ingest → retrieval → summarization →
// validation → memory_write. We always render these five nodes so the
// architecture is visible even when no run is in progress.
const PIPELINE = [
  "ingest_received",
  "retrieval",
  "summarization",
  "validation",
  "memory_write",
];

const NODE_LABELS = {
  ingest_received: "Ingest",
  retrieval: "Retrieval",
  summarization: "Summarization",
  validation: "Validation",
  memory_write: "Memory",
};

const BASE_COLOR = {
  ingest_received: "#94a3b8",
  retrieval: "#3b82f6",
  summarization: "#a855f7",
  validation: "#22c55e",
  memory_write: "#22c55e",
};

function colorFor(stepName, completed) {
  if (
    stepName === "validation" &&
    completed &&
    completed.status === "FAIL"
  ) {
    return "#ef4444";
  }
  if (
    stepName === "memory_write" &&
    completed &&
    completed.status === "skipped"
  ) {
    return "#94a3b8";
  }
  return BASE_COLOR[stepName] ?? "#94a3b8";
}

export default function DataFlowCanvas({ task, runningStep }) {
  const ref = useRef(null);
  const animRef = useRef({
    edgeProgress: 0,
    lastRunning: null,
    pulseT: 0,
  });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let frameId;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    resize();
    window.addEventListener("resize", resize);

    function drawGrid(w, h) {
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      const gridSize = 50;
      for (let x = 0; x < w; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    function draw() {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      drawGrid(w, h);

      const timelineMap = new Map();
      (task?.timeline ?? []).forEach((t) => {
        if (t.step) timelineMap.set(t.step, t);
      });

      const n = PIPELINE.length;
      const nodeY = h * 0.32;
      const margin = Math.max(120, w * 0.1);
      const span = Math.max(0, w - 2 * margin);
      const positions = PIPELINE.map((_, i) => ({
        x: margin + (i * span) / (n - 1),
        y: nodeY,
      }));

      // Animation refs
      if (runningStep !== animRef.current.lastRunning) {
        animRef.current.edgeProgress = 0;
        animRef.current.lastRunning = runningStep;
      }
      if (runningStep && animRef.current.edgeProgress < 1) {
        animRef.current.edgeProgress = Math.min(
          1,
          animRef.current.edgeProgress + 0.04,
        );
      }
      animRef.current.pulseT += 0.08;

      const runningIdx = runningStep ? PIPELINE.indexOf(runningStep) : -1;

      // Edges
      for (let i = 0; i < n - 1; i++) {
        const a = positions[i];
        const b = positions[i + 1];
        const targetStep = PIPELINE[i + 1];
        const sourceCompleted = timelineMap.has(PIPELINE[i]);
        const targetCompleted = timelineMap.has(targetStep);
        const isRunningEdge = runningStep === targetStep && sourceCompleted;
        const isPastEdge = sourceCompleted && targetCompleted;

        ctx.lineWidth = isRunningEdge ? 2 : 1;
        ctx.strokeStyle = isRunningEdge
          ? colorFor(targetStep, timelineMap.get(targetStep))
          : isPastEdge
            ? "rgba(255,255,255,0.35)"
            : "rgba(255,255,255,0.1)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        if (isRunningEdge) {
          const t = animRef.current.edgeProgress;
          const px = a.x + (b.x - a.x) * t;
          const py = a.y + (b.y - a.y) * t;
          const c = colorFor(targetStep, null);
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.shadowBlur = 18;
          ctx.shadowColor = c;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // Nodes
      PIPELINE.forEach((stepName, i) => {
        const p = positions[i];
        const completed = timelineMap.get(stepName);
        const isRunning = runningStep === stepName;
        const isComplete = !!completed;
        const c = colorFor(stepName, completed);

        let alpha;
        let radius = 14;
        let glow;

        if (isRunning) {
          // pulsing
          const pulse = 0.5 + 0.5 * Math.sin(animRef.current.pulseT);
          alpha = 0.6 + 0.35 * pulse;
          radius = 14 + 2 * pulse;
          glow = 22 + 14 * pulse;
        } else if (isComplete) {
          alpha = 0.95;
          glow = 10;
        } else {
          alpha = 0.22;
          glow = 0;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = glow;
        ctx.shadowColor = c;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        // label
        ctx.fillStyle = isRunning || isComplete
          ? "#ffffff"
          : "rgba(255,255,255,0.4)";
        ctx.font = `${isRunning || isComplete ? 600 : 400} 13px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(NODE_LABELS[stepName] ?? stepName, p.x, p.y + 36);

        // status sub-label for validation / memory
        if (
          completed &&
          stepName === "validation" &&
          completed.status
        ) {
          ctx.fillStyle =
            completed.status === "PASS"
              ? "#22c55e"
              : completed.status === "FAIL"
                ? "#ef4444"
                : "rgba(255,255,255,0.5)";
          ctx.font = "11px system-ui";
          ctx.fillText(completed.status, p.x, p.y + 52);
        }
        if (
          completed &&
          stepName === "memory_write" &&
          completed.status
        ) {
          ctx.fillStyle =
            completed.status === "written" ||
            completed.status === "replaced"
              ? "#22c55e"
              : "rgba(255,255,255,0.5)";
          ctx.font = "11px system-ui";
          ctx.fillText(completed.status, p.x, p.y + 52);
        }
        if (isRunning && !isComplete) {
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.font = "italic 11px system-ui";
          ctx.fillText("running…", p.x, p.y + 52);
        }
      });

      frameId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
    };
  }, [task, runningStep]);

  return (
    <canvas
      ref={ref}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
      }}
    />
  );
}
