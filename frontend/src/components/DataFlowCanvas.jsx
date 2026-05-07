import { useEffect, useRef } from "react";

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

function colorFor(step) {
  if (!step) return "#94a3b8";
  if (step.step === "validation" && step.status === "FAIL") return "#ef4444";
  if (step.step === "memory_write" && step.status === "skipped") return "#94a3b8";
  return BASE_COLOR[step.step] ?? "#94a3b8";
}

export default function DataFlowCanvas({ task, activeStep }) {
  const ref = useRef(null);
  const animRef = useRef({ progress: 0, lastStep: null });

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

      const timeline = task?.timeline ?? [];
      if (timeline.length === 0) {
        frameId = requestAnimationFrame(draw);
        return;
      }

      const n = timeline.length;
      const nodeY = h * 0.32;
      const margin = Math.max(120, w * 0.1);
      const span = Math.max(0, w - 2 * margin);
      const positions = timeline.map((_, i) => ({
        x: n === 1 ? w / 2 : margin + (i * span) / (n - 1),
        y: nodeY,
      }));

      if (activeStep !== animRef.current.lastStep) {
        animRef.current.progress = 0;
        animRef.current.lastStep = activeStep;
      }
      if (animRef.current.progress < 1) {
        animRef.current.progress = Math.min(1, animRef.current.progress + 0.045);
      }

      for (let i = 0; i < n - 1; i++) {
        const a = positions[i];
        const b = positions[i + 1];
        const isActiveEdge = activeStep != null && activeStep === i + 1;
        const isPastEdge = activeStep != null && activeStep > i + 1;

        ctx.lineWidth = isActiveEdge ? 2 : 1;
        ctx.strokeStyle = isActiveEdge
          ? colorFor(timeline[i + 1])
          : isPastEdge
            ? "rgba(255,255,255,0.35)"
            : "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        if (isActiveEdge) {
          const t = animRef.current.progress;
          const px = a.x + (b.x - a.x) * t;
          const py = a.y + (b.y - a.y) * t;
          const c = colorFor(timeline[i + 1]);
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.shadowBlur = 18;
          ctx.shadowColor = c;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      timeline.forEach((step, i) => {
        const p = positions[i];
        const isActive = activeStep === i;
        const isPast = activeStep != null && i < activeStep;
        const c = colorFor(step);

        ctx.beginPath();
        ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.globalAlpha = isActive ? 1 : isPast ? 0.85 : 0.3;
        ctx.shadowBlur = isActive ? 30 : isPast ? 8 : 0;
        ctx.shadowColor = c;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        ctx.fillStyle = isActive ? "#ffffff" : "rgba(255,255,255,0.55)";
        ctx.font = `${isActive ? 600 : 400} 13px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(NODE_LABELS[step.step] ?? step.step, p.x, p.y + 36);

        if (step.step === "validation" && step.status) {
          ctx.fillStyle =
            step.status === "PASS"
              ? "#22c55e"
              : step.status === "FAIL"
                ? "#ef4444"
                : "rgba(255,255,255,0.5)";
          ctx.font = "11px system-ui";
          ctx.fillText(step.status, p.x, p.y + 52);
        }
        if (step.step === "memory_write" && step.status) {
          ctx.fillStyle =
            step.status === "written"
              ? "#22c55e"
              : "rgba(255,255,255,0.5)";
          ctx.font = "11px system-ui";
          ctx.fillText(step.status, p.x, p.y + 52);
        }
      });

      frameId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
    };
  }, [task, activeStep]);

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
