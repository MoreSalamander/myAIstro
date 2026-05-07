import { useEffect, useRef } from "react";

export default function DataFlowCanvas({ task, activeStep }) {
  const ref = useRef(null);

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

    function draw() {
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // =========================
      // GRID
      // =========================
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      const gridSize = 50;

      for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }

      for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // =========================
      // STEP
      // =========================
        const rawStep = task?.timeline?.[activeStep]?.step ?? null;

        const stepMap = {
        ingest_received: "retrieval",
        processing_placeholder: "summarization",
        };

        const step = stepMap[rawStep] ?? rawStep;


      const w = canvas.width;
      const h = canvas.height;

      const nodes = [
        { name: "retrieval", x: w * 0.25, y: h * 0.35, color: "#3b82f6" },
        { name: "summarization", x: w * 0.5, y: h * 0.35, color: "#a855f7" },
        { name: "validation", x: w * 0.75, y: h * 0.35, color: "#22c55e" },
      ];

      // =========================
      // NODES
      // =========================
      nodes.forEach((n) => {
        const active = n.name === step;

        ctx.beginPath();
        ctx.arc(n.x, n.y, 14, 0, Math.PI * 2);

        ctx.fillStyle = n.color;

        // intensity control
        ctx.globalAlpha = active ? 1 : 0.75;

        ctx.shadowBlur = active ? 30 : 6;
        ctx.shadowColor = n.color;

        ctx.fill();

        // CRITICAL: reset canvas state per frame
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
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
