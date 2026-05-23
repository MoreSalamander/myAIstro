import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ForceGraph2D from "react-force-graph-2d";

// Course palette — chosen for high contrast at low saturation against the
// near-black backdrop. Each course gets a stable assignment via order-of-
// appearance.
const PALETTE = [
  "#39ff14", // neon green
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#84cc16", // lime
  "#ef4444", // red
];

const STAR_COUNT = 220;
const HEADER_OFFSET = 160; // matches App.jsx — content sits below the header

// Synthetic "my-AI-stro Chat" hub at graph origin. Every SOT node is
// linked to it, and a custom tangential force makes them orbit. The
// hub is rendered ~15× larger than normal nodes and its links are not
// drawn (they exist only to pull nodes into orbital range).
const HUB_ID = "__hub__";
const HUB_SCALE = 15; // hub renders at HUB_SCALE × normal node radius
const HUB_ORBIT_RADIUS = 380; // ideal distance from hub for each SOT node
const HUB_EXCLUSION = 250; // hard floor — no node may sit closer than this
// Hard ceiling — counterpart to HUB_EXCLUSION. Canonical SOT nodes can't
// sit further than this from origin without a radial inward push. Gives
// the whole graph a circular outer bound rather than letting it drift
// out indefinitely under charge repulsion + aliveness wander.
const BOUNDARY_RADIUS = 500;

// localStorage key for persisted user-tuned settings
const SETTINGS_STORAGE_KEY = "myaistro_graph_settings";

function loadStoredSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Deep-merge persisted user values over the code defaults. Missing keys
// fall back to defaults, so adding new settings in the future doesn't
// break a saved profile.
function deepMergeSettings(defaults, overrides) {
  if (!overrides || typeof overrides !== "object") return defaults;
  const out = { ...defaults };
  for (const k of Object.keys(overrides)) {
    const v = overrides[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMergeSettings(defaults[k] || {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// Tuned defaults — snapshot of the user's preferred graph configuration.
// A fresh load (or "Reset to defaults") drops back to exactly these values.
const DEFAULT_SETTINGS = {
  filters: {
    enabledCourses: {}, // populated when graph loads (all courses on)
    minLinkWeight: 1,
    searchTerm: "",
  },
  display: {
    showLabels: true,
    showHulls: false,
    showStars: true,
    animatedEdges: false,
    aliveness: true,
    nodeSize: 1.15,
    linkWidth: 1,
  },
  forces: {
    chargeStrength: -600,
    linkDistance: 300,
    linkStrength: 0.2,
    centerStrength: 0.29,
    velocityDecay: 0.95,
    symmetryStrength: 0,
  },
};

export default function GraphPanel({ onSelect, selectedId, onHubClick, dataVersion = 0 }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [size, setSize] = useState({
    w: window.innerWidth,
    h: window.innerHeight - HEADER_OFFSET,
  });
  const [hoverNode, setHoverNode] = useState(null);
  const [hoverPos, setHoverPos] = useState(null); // screen coords for ripple
  // Initialize from localStorage (deep-merged over DEFAULT_SETTINGS) so
  // user tunings survive page reloads. Future schema additions still
  // get their defaults; user changes are layered on top.
  const [settings, setSettings] = useState(() =>
    deepMergeSettings(DEFAULT_SETTINGS, loadStoredSettings()),
  );

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* quota exhausted / private-mode — non-fatal */
    }
  }, [settings]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fgRef = useRef(null);

  // Once the graph loads, default every course to enabled
  useEffect(() => {
    if (!graph?.nodes) return;
    setSettings((prev) => {
      if (Object.keys(prev.filters.enabledCourses).length > 0) return prev;
      const enabled = {};
      for (const n of graph.nodes) {
        const c = n.course ?? "(none)";
        enabled[c] = true;
      }
      return { ...prev, filters: { ...prev.filters, enabledCourses: enabled } };
    });
  }, [graph]);

  const selected = useMemo(
    () => (graph?.nodes ?? []).find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  // Star positions live in graph coords so they pan/zoom with the world.
  // Generated once when the graph loads, then drift via per-frame phase.
  const starsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sot/graph")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setGraph(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  useEffect(() => {
    function onResize() {
      setSize({ w: window.innerWidth, h: window.innerHeight - HEADER_OFFSET });
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

  // -------- Heartbeat pulse system --------
  // A pulse is a small bright spirit that travels along a link from
  // source to target. The hub fires pulses to every SOT node every
  // HEARTBEAT_MS; when each arrives, it spawns one-hop child pulses
  // along that node's concept-link neighbors. After two cascades it
  // dies — no infinite propagation.
  const pulsesRef = useRef([]);

  // Map of nodeId → array of neighbor nodeIds (concept-links only).
  const adjacency = useMemo(() => {
    const map = new Map();
    if (!graph?.links) return map;
    for (const l of graph.links) {
      if (l.isHubLink) continue;
      const sId = typeof l.source === "object" ? l.source.id : l.source;
      const tId = typeof l.target === "object" ? l.target.id : l.target;
      if (!map.has(sId)) map.set(sId, []);
      if (!map.has(tId)) map.set(tId, []);
      map.get(sId).push(tId);
      map.get(tId).push(sId);
    }
    return map;
  }, [graph]);

  // Audit satellites — audit-generated nodes that are NOT the
  // canonical of their lesson group. (A v2 whose v1 was archived is
  // marked audit_generated:true AND is_canonical:true; it should
  // render as canonical, not as a satellite. Hence the `&& !is_canonical`.)
  const auditNodeIds = useMemo(() => {
    const out = new Set();
    if (!graph?.nodes) return out;
    for (const n of graph.nodes) {
      if (n.audit_generated && !n.is_canonical) out.add(n.id);
    }
    return out;
  }, [graph]);

  // Per-node degree — number of links touching this node in the current
  // (filter-aware) graph view. Drives subtle node-size scaling so well-
  // connected lessons read as visually heavier.
  const degreeByNode = useMemo(() => {
    const out = {};
    if (!graph?.links) return out;
    for (const n of graph.nodes ?? []) out[n.id] = 0;
    for (const l of graph.links) {
      // Hub-spokes and tethers are bookkeeping, not real connections —
      // they shouldn't inflate node-size-by-degree scaling.
      if (l.isHubLink || l.isTether) continue;
      const sId = typeof l.source === "object" ? l.source.id : l.source;
      const tId = typeof l.target === "object" ? l.target.id : l.target;
      if (sId in out) out[sId] += 1;
      if (tId in out) out[tId] += 1;
    }
    return out;
  }, [graph]);

  // Sqrt-scaled growth: more connections = bigger, but with diminishing
  // returns so a node with 25 links isn't 25× the size of an isolated one.
  // 0 links → 1.0×, 1 → 1.10×, 4 → 1.20×, 9 → 1.30×, 16 → 1.40×, 25 → 1.50×.
  const degreeScale = useCallback(
    (id) => 1 + Math.sqrt(degreeByNode[id] ?? 0) * 0.1,
    [degreeByNode],
  );

  // Per-node recency weight: 1.0 for the newest entry, fading to 0.15 for
  // anything older than 30 days. Used for the outer glow ring.
  const recencyByNode = useMemo(() => {
    const out = {};
    if (!graph?.nodes) return out;
    const times = graph.nodes
      .map((n) => Date.parse(n.created_at || ""))
      .filter((t) => !Number.isNaN(t));
    if (times.length === 0) {
      for (const n of graph.nodes) out[n.id] = 0.15;
      return out;
    }
    const newest = Math.max(...times);
    const dayMs = 86_400_000;
    const horizon = 30 * dayMs;
    for (const n of graph.nodes) {
      const t = Date.parse(n.created_at || "");
      if (Number.isNaN(t)) {
        out[n.id] = 0.15;
        continue;
      }
      const ageDays = (newest - t) / dayMs;
      const w = Math.max(0.15, 1 - ageDays / 30);
      out[n.id] = w;
    }
    return out;
  }, [graph]);

  // Apply filters: course toggles, min link weight, search term.
  // Memoized — but the existing graph.nodes/links references are kept
  // when no filter applies, so the simulation doesn't restart needlessly.
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    const term = settings.filters.searchTerm.toLowerCase().trim();
    const enabled = settings.filters.enabledCourses;
    const enabledKeysCount = Object.keys(enabled).length;

    const nodesPass = (n) => {
      const c = n.course ?? "(none)";
      if (enabledKeysCount > 0 && enabled[c] === false) return false;
      if (term) {
        const hay = `${n.lesson || ""} ${n.course || ""} ${(n.key_concepts || []).join(" ")}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    };

    const allPass = graph.nodes.every(nodesPass);
    const nodes = allPass ? graph.nodes : graph.nodes.filter(nodesPass);
    const visibleIds = new Set(nodes.map((n) => n.id));

    const linksPass = (l) => {
      const sId = typeof l.source === "object" ? l.source.id : l.source;
      const tId = typeof l.target === "object" ? l.target.id : l.target;
      if (!visibleIds.has(sId) || !visibleIds.has(tId)) return false;
      if ((l.weight ?? 1) < settings.filters.minLinkWeight) return false;
      return true;
    };

    const allLinksPass = graph.links.every(linksPass);
    const conceptLinks = allLinksPass ? graph.links : graph.links.filter(linksPass);

    // Inject hub node at origin. fx/fy/fz pin it so the simulation
    // can't push it around. The whole graph orbits this anchor.
    const hub = {
      id: HUB_ID,
      isHub: true,
      course: "__hub__",
      lesson: "my-AI-stro Chat",
      fx: 0,
      fy: 0,
      fz: 0,
      x: 0,
      y: 0,
      z: 0,
    };
    // Hub spokes go ONLY to canonicals — audit satellites are tethered
    // to their canonical instead of getting their own hub spoke.
    const hubLinks = nodes
      .filter((n) => n.is_canonical)
      .map((n) => ({
        source: HUB_ID,
        target: n.id,
        isHubLink: true,
        weight: 0,
      }));
    // Tether links: each audit *satellite* (audit_generated AND NOT
    // canonical itself) gets a tether to its canonical sibling.
    // Guards against self-tethers when an audit entry became canonical
    // after its v1 was archived.
    const tetherLinks = nodes
      .filter(
        (n) =>
          n.audit_generated &&
          !n.is_canonical &&
          n.canonical_event_id &&
          n.canonical_event_id !== n.id,
      )
      .map((n) => ({
        source: n.canonical_event_id,
        target: n.id,
        isTether: true,
        weight: 0,
      }));

    return {
      nodes: [hub, ...nodes],
      links: [...conceptLinks, ...hubLinks, ...tetherLinks],
    };
  }, [graph, settings.filters]);

  // Heartbeat — fire a fresh wave of pulses from the hub to each SOT
  // node exactly when the previous wave's return leg arrives home.
  // Interval = full 3-hop round trip (1400 hub→SOT + 900 SOT→neighbor
  // + 1400 neighbor→hub = 3700ms). Zero overlap and zero rest — the
  // outbound wave launches in the same frame the return wave lands,
  // giving a continuous "tide" feel rather than discrete heartbeats.
  // Placed after graphData definition so the closure can read the latest
  // node list without hitting the TDZ.
  useEffect(() => {
    if (!graph?.nodes?.length) return;
    const HEARTBEAT_MS = 3700;
    const fire = () => {
      const nodes = graphData.nodes;
      const hub = nodes.find((n) => n.isHub);
      if (!hub) return;
      const now = performance.now();
      for (const n of nodes) {
        if (n.isHub) continue;
        pulsesRef.current.push({
          source: hub,
          target: n,
          startTime: now,
          duration: 1400,
          depth: 0,
          // hub → SOT spokes are white the whole way
          headStartColor: "#ffffff",
          headEndColor: "#ffffff",
        });
      }
    };
    fire();
    const t = setInterval(fire, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [graph, graphData, courseColor]);

  // Baseline alpha — keep the d3 simulation always-ticking so display
  // toggles (course hulls, starfield, animated edges) and force changes
  // always render. Aliveness was previously controlling this, but it
  // also has visual effects of its own (wander + halo glow); the two
  // are now decoupled. Even with aliveness off, alpha stays slightly
  // above zero so the canvas keeps repainting.
  const baselineAlpha = 0.04;

  // Map of course → angular slot around origin (radians). Courses are
  // distributed evenly so the layout becomes radially symmetric.
  const courseAngles = useMemo(() => {
    const out = {};
    const courses = Object.keys(courseColor);
    courses.forEach((c, i) => {
      out[c] = (i / Math.max(courses.length, 1)) * Math.PI * 2;
    });
    return out;
  }, [courseColor]);

  // Apply force settings via the d3 simulation handles. Also installs a
  // custom 'symmetry' force that pulls each node toward its course's
  // angular anchor on a ring around origin — produces a flower-like
  // symmetric shape rather than a sprawling blob.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph) return;
    const charge = fg.d3Force("charge");
    const link = fg.d3Force("link");
    const center = fg.d3Force("center");

    // CRITICAL: d3-force caches per-node and per-link arrays inside
    // `initialize()`. Setting strength/distance only updates the
    // function the force will use on NEXT initialize — without an
    // explicit reinit, slider changes were silently no-op'ing. Re-call
    // initialize after each parameter change.
    //
    // Use graphData.nodes (the array the simulation was initialized
    // with) so per-node `.index` assignments stay in sync. Using the
    // unfiltered graph.nodes would re-index against a superset and
    // corrupt the link force's source/target index lookups.
    const nodes = graphData.nodes;
    const reinit = (force) => {
      if (force && typeof force.initialize === "function") {
        try {
          force.initialize(nodes, Math.random);
        } catch {
          /* some force implementations don't accept this signature */
        }
      }
    };

    if (charge) {
      // Hub doesn't repel — give it zero charge so it doesn't push
      // the orbit nodes outward. Normal nodes repel each other normally.
      charge.strength((n) =>
        n.isHub ? 0 : settings.forces.chargeStrength,
      );
      reinit(charge);
    }
    if (link) {
      // Per-link distance / strength rules:
      //   hub spoke    → long (orbital radius), gentle pull
      //   tether       → very short, very rigid (audit glued to canonical)
      //   concept link → user-tunable
      link.distance((l) => {
        if (l.isHubLink) return HUB_ORBIT_RADIUS;
        if (l.isTether) return 26;
        return settings.forces.linkDistance;
      });
      link.strength((l) => {
        if (l.isHubLink) return 0.18;
        if (l.isTether) return 0.9;
        return settings.forces.linkStrength;
      });
      reinit(link);
    }
    if (center && center.strength) {
      center.strength(settings.forces.centerStrength);
    }

    // ---- Orbital force ----
    // Per tick, give every non-hub node a small tangential velocity
    // perpendicular to its radial vector from origin. Combined with
    // the inward pull of the hub-link, this produces stable circular
    // orbits in the XY plane.
    fg.d3Force("orbital", (alphaTick) => {
      const k = 0.4 * alphaTick;
      for (const n of nodes) {
        if (n.isHub) continue;
        // Audit satellites follow their canonical via the tether link;
        // they shouldn't have independent orbital momentum. Audit-
        // entries that ARE canonical (v1 was archived) still orbit.
        if (n.audit_generated && !n.is_canonical) continue;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const dx = n.x;
        const dy = n.y;
        const r = Math.hypot(dx, dy);
        if (r < 1e-3) continue;
        // Tangent direction = radial rotated 90° = (-dy, dx) / r
        n.vx = (n.vx ?? 0) + (-dy / r) * k;
        n.vy = (n.vy ?? 0) + (dx / r) * k;
      }
    });

    // ---- Hub exclusion zone ----
    // Hard floor: nothing may sit closer than HUB_EXCLUSION (3× the
    // hub's rendered radius) from origin. Anything inside that radius
    // gets pushed radially outward each tick.
    fg.d3Force("hubExclusion", (alphaTick) => {
      for (const n of nodes) {
        if (n.isHub) continue;
        // Audit satellites follow their canonical; let the tether
        // handle their position rather than the exclusion zone.
        if (n.audit_generated && !n.is_canonical) continue;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const r = Math.hypot(n.x, n.y);
        if (r === 0 || r >= HUB_EXCLUSION) continue;
        const penetration = HUB_EXCLUSION - r;
        // Strong outward push — proportional to how deep the node
        // has slipped inside the exclusion zone.
        const push = penetration * 0.5;
        n.vx = (n.vx ?? 0) + (n.x / r) * push;
        n.vy = (n.vy ?? 0) + (n.y / r) * push;
        if (typeof n.z === "number") {
          // 3D: push along the same outward direction (radial in XY)
          // — keeps orbit plane consistent with 2D behavior.
        }
      }
    });

    // ---- Outer boundary ----
    // Hard ceiling: canonical SOT nodes can't drift further than
    // BOUNDARY_RADIUS from origin. Nodes that overshoot get pushed
    // radially inward each tick, proportional to overshoot. Mirror
    // image of hubExclusion. Audit satellites are skipped so they
    // can follow their canonical via the tether even if the canonical
    // sits right at the wall — letting the boundary force compete
    // with the tether would make satellites jitter at the edge.
    //
    // Push coefficient (0.18) is lower than hubExclusion's (0.5)
    // because (a) overshoot magnitudes here can be much larger than
    // inner-floor penetrations under aliveness wander, so a strong
    // coefficient would yank nodes hard, and (b) we want the wall to
    // feel like a membrane, not a brick — nodes leaning on it from
    // the outside should be cushioned, not slingshot.
    fg.d3Force("outerBoundary", (alphaTick) => {
      for (const n of nodes) {
        if (n.isHub) continue;
        if (n.audit_generated && !n.is_canonical) continue;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const r = Math.hypot(n.x, n.y);
        if (r <= BOUNDARY_RADIUS) continue;
        const overshoot = r - BOUNDARY_RADIUS;
        const push = overshoot * 0.18;
        // Inward radial push: subtract the unit-radial × push from velocity
        n.vx = (n.vx ?? 0) - (n.x / r) * push;
        n.vy = (n.vy ?? 0) - (n.y / r) * push;
      }
    });

    // Custom symmetry force — install or update.
    // When aliveness is on, the entire formation is dragged around by a
    // slow Lissajous wander applied as an offset to every course anchor.
    // The shape stays symmetric; the whole thing translates organically.
    const ringRadius = 220;
    const alive = settings.display.aliveness;
    const sym = (alpha) => {
      const k = settings.forces.symmetryStrength * alpha;
      if (k <= 0) return;
      const t = performance.now();
      const wanderX = alive ? Math.sin(t * 0.00018) * 140 : 0;
      const wanderY = alive ? Math.cos(t * 0.00023) * 100 : 0;
      const wobble = alive ? Math.sin(t * 0.00011) * 30 : 0;
      for (const n of graph.nodes) {
        const a = courseAngles[n.course ?? "(none)"];
        if (a == null) continue;
        const r = ringRadius + wobble;
        const tx = Math.cos(a) * r + wanderX;
        const ty = Math.sin(a) * r + wanderY;
        if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
          n.vx = (n.vx ?? 0) + (tx - n.x) * k;
          n.vy = (n.vy ?? 0) + (ty - n.y) * k;
        }
      }
    };
    fg.d3Force("symmetry", sym);

    // Re-energize the simulation so the new force values are visible.
    // This briefly rearranges the graph — that visible response IS the
    // signal the slider is doing something.
    fg.d3ReheatSimulation?.();
    fg.d3AlphaTarget?.(baselineAlpha);
  }, [
    graph,
    settings.forces,
    settings.display.aliveness,
    courseAngles,
    baselineAlpha,
  ]);

  // Reposition the camera onto the hover/selected node screen coordinate
  // when needed — used by the hover-ripple HTML overlay.
  useEffect(() => {
    if (!hoverNode || !fgRef.current) {
      setHoverPos(null);
      return;
    }
    const fg = fgRef.current;
    let raf;
    function tick() {
      if (typeof hoverNode.x !== "number" || typeof hoverNode.y !== "number") return;
      const p = fg.graph2ScreenCoords(hoverNode.x, hoverNode.y);
      setHoverPos(p);
      raf = requestAnimationFrame(tick);
    }
    tick();
    return () => cancelAnimationFrame(raf);
  }, [hoverNode]);

  // Initialize stars once we know the data — spread them across a generous
  // area so panning still reveals stars at the edges.
  useEffect(() => {
    if (!graphData.nodes.length) return;
    if (starsRef.current) return;
    const stars = [];
    const range = 1400;
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: (Math.random() - 0.5) * range * 2,
        y: (Math.random() - 0.5) * range * 2,
        size: Math.random() * 0.9 + 0.2,
        baseAlpha: Math.random() * 0.5 + 0.15,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: Math.random() * 0.6 + 0.3,
      });
    }
    starsRef.current = stars;
  }, [graphData]);

  // Course-hull centroids/radii — recomputed each frame in renderPre since
  // node positions drift while the simulation runs.
  const computeHulls = useCallback(() => {
    if (!graphData.nodes.length) return [];
    const groups = new Map();
    for (const n of graphData.nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      const c = n.course ?? "(none)";
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(n);
    }
    const out = [];
    for (const [course, nodes] of groups) {
      if (nodes.length === 0) continue;
      let cx = 0, cy = 0;
      for (const n of nodes) { cx += n.x; cy += n.y; }
      cx /= nodes.length; cy /= nodes.length;
      let r = 0;
      for (const n of nodes) {
        const d = Math.hypot(n.x - cx, n.y - cy);
        if (d > r) r = d;
      }
      out.push({ course, cx, cy, radius: r + 60 });
    }
    return out;
  }, [graphData]);

  // ============================================================
  //  RENDER FRAME — PRE  (background → stars → hulls)
  // ============================================================
  // Build a quick lookup from id → live node object so cascading
  // pulses can locate the next hop without searching the array.
  const nodeById = useMemo(() => {
    const m = new Map();
    for (const n of graphData.nodes) m.set(n.id, n);
    return m;
  }, [graphData]);

  // Per-frame pulse advance + render. Drawn AFTER nodes/links so the
  // bright spirits sit visually on top of the wires.
  const onRenderFramePost = useCallback(
    (ctx) => {
      const now = performance.now();
      const remaining = [];
      for (const p of pulsesRef.current) {
        const elapsed = now - p.startTime;
        if (elapsed < 0) {
          remaining.push(p);
          continue;
        }
        const t = elapsed / p.duration;
        if (
          !Number.isFinite(p.source.x) || !Number.isFinite(p.source.y) ||
          !Number.isFinite(p.target.x) || !Number.isFinite(p.target.y)
        ) {
          // endpoints not yet positioned — keep waiting
          if (t < 1.5) remaining.push(p);
          continue;
        }
        if (t >= 1) {
          // Pulse arrived. Cascade chain:
          //   depth 0  (hub → SOT)        — spawn 2 SOT→SOT relays
          //   depth 1  (SOT → neighbor)   — spawn 1 return-to-hub
          //   depth 2  (neighbor → hub)   — terminate
          if (p.depth === 0) {
            const targetId = p.target.id;
            const neighbors = (adjacency.get(targetId) || []).filter(
              (nId) => nId !== p.source.id,
            );
            // Pick up to 2 distinct random neighbors
            const picks = [];
            const pool = neighbors.slice();
            while (picks.length < 2 && pool.length > 0) {
              const idx = Math.floor(Math.random() * pool.length);
              picks.push(pool[idx]);
              pool.splice(idx, 1);
            }
            for (const nId of picks) {
              const next = nodeById.get(nId);
              if (!next) continue;
              // SOT → SOT pulse rides the gradient connection line: head
              // color shifts from source course color to target course
              // color over the traversal, matching the line underneath.
              const sColor =
                courseColor[p.target.course ?? "(none)"] ?? "#39ff14";
              const tColor =
                courseColor[next.course ?? "(none)"] ?? "#39ff14";
              pulsesRef.current.push({
                source: p.target,
                target: next,
                startTime: now,
                duration: 900,
                depth: 1,
                headStartColor: sColor,
                headEndColor: tColor,
              });
            }
          } else if (p.depth === 1) {
            // Return leg: neighbor SOT → hub. Color gradient mirrors
            // the hub-spoke line (course color at SOT end, white at
            // hub end), so the comet visually rides its own spoke home.
            const hub = nodeById.get(HUB_ID);
            if (hub) {
              const sColor =
                courseColor[p.target.course ?? "(none)"] ?? "#39ff14";
              pulsesRef.current.push({
                source: p.target,
                target: hub,
                startTime: now,
                duration: 1400,
                depth: 2,
                headStartColor: sColor,
                headEndColor: "#ffffff",
              });
            }
          }
          continue;
        }
        // Linear position — constant velocity across each leg, no
        // deceleration into the target node and no acceleration out of
        // the source node. Previous easeInOutQuad slowed the comet to
        // near-zero velocity at handoffs (hub→SOT, SOT→neighbor,
        // neighbor→hub), creating a perceptible "rest" at each node
        // even though the handoff was instant. Linear flow lets the
        // pulse traverse the full 3-hop cycle as one continuous motion.
        const eased = t;
        const dx = p.target.x - p.source.x;
        const dy = p.target.y - p.source.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) {
          remaining.push(p);
          continue;
        }
        const ux = dx / len;
        const uy = dy / len;
        const x = p.source.x + dx * eased;
        const y = p.source.y + dy * eased;
        const alpha = Math.sin(t * Math.PI) * 0.95;

        // Color of the comet at this moment — for hub→SOT pulses both
        // endpoints are white, so this is white throughout. For
        // SOT→SOT pulses it lerps from source course color to target
        // course color, matching the gradient on the connection line.
        const headColor = lerpHex(
          p.headStartColor || "#ffffff",
          p.headEndColor || "#ffffff",
          eased,
        );

        // Comet tail — short bright segment trailing along the link
        const tailLen = Math.min(34, len * 0.18);
        const tx = x - ux * tailLen;
        const ty = y - uy * tailLen;
        const tail = ctx.createLinearGradient(tx, ty, x, y);
        tail.addColorStop(0, hexToRgba(headColor, 0));
        tail.addColorStop(1, hexToRgba(headColor, 0.85 * alpha));
        ctx.strokeStyle = tail;
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();

        // Bright head — colored core with matching glow
        ctx.beginPath();
        ctx.arc(x, y, 3.6, 0, 2 * Math.PI);
        ctx.fillStyle = hexToRgba(headColor, alpha);
        ctx.shadowBlur = 22;
        ctx.shadowColor = headColor;
        ctx.fill();
        ctx.shadowBlur = 0;

        remaining.push(p);
      }
      pulsesRef.current = remaining;
    },
    [adjacency, nodeById],
  );

  const onRenderFramePre = useCallback(
    (ctx) => {
      const t = performance.now();

      // 0. Outer boundary ring — faint circle marking the radius at
      // which the outerBoundary force kicks in. Drawn first so it sits
      // behind hulls, stars, links, and nodes. Stroke only, no fill,
      // so anything inside (which is everything) renders normally.
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, BOUNDARY_RADIUS, 0, 2 * Math.PI);
      ctx.stroke();

      // 1. Course hulls (soft glowing blobs behind nodes)
      if (settings.display.showHulls) {
        const hulls = computeHulls();
        for (const h of hulls) {
          const color = courseColor[h.course] ?? "#94a3b8";
          const grad = ctx.createRadialGradient(
            h.cx, h.cy, 0,
            h.cx, h.cy, h.radius,
          );
          grad.addColorStop(0, hexToRgba(color, 0.18));
          grad.addColorStop(0.55, hexToRgba(color, 0.06));
          grad.addColorStop(1, hexToRgba(color, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(h.cx, h.cy, h.radius, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      // 2. Stars (drift up + sine sway, twinkle on alpha)
      if (settings.display.showStars) {
        const stars = starsRef.current;
        if (stars) {
          const drift = (t * 0.000008) % 1; // very slow drift
          for (const s of stars) {
            const a =
              s.baseAlpha *
              (0.55 + 0.45 * Math.sin(t * 0.001 * s.twinkleSpeed + s.twinklePhase));
            ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
            const sx = s.x + Math.sin(t * 0.0002 + s.twinklePhase) * 4;
            const sy = s.y - drift * 80; // gentle upward parallax
            ctx.beginPath();
            ctx.arc(sx, sy, s.size, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
      }
    },
    [computeHulls, courseColor, settings.display.showHulls, settings.display.showStars],
  );

  // ============================================================
  //  LINK   — animated dashed neon edges
  // ============================================================
  const drawLink = useCallback(
    (link, ctx) => {
      const a = link.source;
      const b = link.target;
      if (!a || !b) return;
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return;
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;

      // Tether: faint dashed line from canonical → audit satellite.
      // Purely visual; the link force does the actual positioning.
      if (link.isTether) {
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }

      // Hub-links: thin white→course-color spoke from the hub out to
      // each SOT node. Drawn underneath the regular concept-links.
      if (link.isHubLink) {
        const hubEnd = a.isHub ? a : b;
        const nodeEnd = a.isHub ? b : a;
        const nodeColor =
          courseColor[nodeEnd.course ?? "(none)"] ?? "#39ff14";
        const grad = ctx.createLinearGradient(
          hubEnd.x, hubEnd.y, nodeEnd.x, nodeEnd.y,
        );
        grad.addColorStop(0, "rgba(255,255,255,0.35)");
        grad.addColorStop(1, hexToRgba(nodeColor, 0.15));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(hubEnd.x, hubEnd.y);
        ctx.lineTo(nodeEnd.x, nodeEnd.y);
        ctx.stroke();
        return;
      }

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;

      const weight = link.weight ?? 1;
      const widthMul = settings.display.linkWidth;
      const baseW = Math.min(2.2, 0.6 + weight * 0.45) * widthMul;

      // Endpoint course colors → gradient stops along the line
      const sColor = courseColor[a.course ?? "(none)"] ?? "#39ff14";
      const tColor = courseColor[b.course ?? "(none)"] ?? "#39ff14";

      // Glow underlay — same gradient, low alpha
      const glow = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      glow.addColorStop(0, hexToRgba(sColor, 0.12));
      glow.addColorStop(1, hexToRgba(tColor, 0.12));
      ctx.strokeStyle = glow;
      ctx.lineWidth = baseW + 2.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Top stroke (with optional flowing dashes) — full gradient
      if (settings.display.animatedEdges) {
        const t = performance.now();
        const offset = -(t * 0.04) % 24;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = offset;
      }
      const dash = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      dash.addColorStop(0, hexToRgba(sColor, 0.7));
      dash.addColorStop(1, hexToRgba(tColor, 0.7));
      ctx.strokeStyle = dash;
      ctx.lineWidth = baseW;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    },
    [settings.display.animatedEdges, settings.display.linkWidth, courseColor],
  );

  // ============================================================
  //  NODE  — core disc + recency-scaled glow + selection ring
  // ============================================================
  const drawNode = useCallback(
    (node, ctx, globalScale) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;

      // -------- HUB --------
      if (node.isHub) {
        const baseR = 5.5;
        const r = baseR * HUB_SCALE;
        const isHubHover = hoverNode?.id === HUB_ID;

        // White glow halo
        const halo = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * 1.8);
        halo.addColorStop(0, "rgba(255,255,255,0.45)");
        halo.addColorStop(0.5, "rgba(255,255,255,0.18)");
        halo.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 1.8, 0, 2 * Math.PI);
        ctx.fill();

        // Black core
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = "#000000";
        ctx.shadowBlur = isHubHover ? 60 : 40;
        ctx.shadowColor = "#ffffff";
        ctx.fill();
        ctx.shadowBlur = 0;

        // White outline
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.strokeStyle = isHubHover ? "#ffffff" : "rgba(255,255,255,0.85)";
        ctx.lineWidth = isHubHover ? 3 : 2;
        ctx.stroke();
        return;
      }

      const isSelected = selected?.id === node.id;
      const isHover = hoverNode?.id === node.id;
      const isAudit = !!node.audit_generated && !node.is_canonical;
      const color = courseColor[node.course ?? "(none)"] ?? "#94a3b8";
      const w = recencyByNode[node.id] ?? 0.3;
      // Audit satellites render at ~55% of canonical size with a
      // dimmer halo, so they're identifiable as repeat-versions.
      const auditScale = isAudit ? 0.55 : 1.0;
      const auditAlpha = isAudit ? 0.5 : 1.0;
      const sizeMul = settings.display.nodeSize * degreeScale(node.id) * auditScale;

      // Outer recency glow — soft halo, scales with how recent the lesson is.
      // When aliveness is on, the halo *brightens and dims* on its own phase
      // (no size change). Each node has a slightly different phase so the
      // field shimmers asynchronously instead of pulsing in lockstep.
      const t = performance.now();
      const phase = (node.id?.toString().charCodeAt(0) ?? 0) * 0.13;
      const glow = settings.display.aliveness
        ? 0.7 + 0.3 * Math.sin(t * 0.0011 + phase)
        : 1;
      const haloR =
        (18 + w * 20 + (isSelected ? 10 : 0) + (isHover ? 5 : 0)) * sizeMul;
      const grad = ctx.createRadialGradient(
        node.x, node.y, 0,
        node.x, node.y, haloR,
      );
      grad.addColorStop(0, hexToRgba(color, (0.7 * w + (isSelected ? 0.25 : 0)) * glow * auditAlpha));
      grad.addColorStop(0.5, hexToRgba(color, 0.3 * w * glow * auditAlpha));
      grad.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(node.x, node.y, haloR, 0, 2 * Math.PI);
      ctx.fill();

      // Solid black core. Course identity reads entirely through the
      // surrounding halo glow that's drawn behind the core (see the
      // outer recency glow above) plus the strong shadowColor here.
      const r = (isSelected ? 7.5 : isHover ? 6.5 : 5.5) * sizeMul;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = "#000000";
      ctx.shadowBlur = isSelected ? 28 : 18;
      ctx.shadowColor = color;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Selection ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
        ctx.strokeStyle = hexToRgba(color, 0.85);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Label
      if (settings.display.showLabels || isSelected || isHover) {
        const fontSize = Math.max(9, 10.5 / globalScale);
        ctx.font = `${
          isSelected ? 600 : 500
        } ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isSelected
          ? "#ffffff"
          : isHover
          ? "rgba(255,255,255,0.92)"
          : "rgba(255,255,255,0.62)";
        const label = node.lesson ?? "";
        ctx.fillText(
          label.length > 32 ? label.slice(0, 31) + "…" : label,
          node.x,
          node.y + r + 4,
        );
      }
    },
    [
      selected,
      hoverNode,
      courseColor,
      recencyByNode,
      degreeScale,
      auditNodeIds,
      settings.display.showLabels,
      settings.display.nodeSize,
      settings.display.aliveness,
    ],
  );

  if (error) {
    return (
      <Container>
        <div style={{ color: "var(--danger)" }}>{error}</div>
      </Container>
    );
  }
  if (!graph) {
    return (
      <Container>
        <div style={{ color: "var(--text-dim)" }}>Loading graph…</div>
      </Container>
    );
  }
  if (graph.nodes.length === 0) {
    return (
      <Container>
        <div style={{ color: "var(--text-dim)" }}>
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
        background: "transparent",
        zIndex: 5,
        cursor: hoverNode ? "pointer" : "default",
      }}
    >
      <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeRelSize={5}
          nodeLabel={() => ""}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.beginPath();
            ctx.arc(node.x, node.y, 12, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
          }}
          linkCanvasObject={drawLink}
          linkCanvasObjectMode={() => "replace"}
          linkLabel={(l) => `shared: ${(l.shared ?? []).join(", ")}`}
          cooldownTicks={Infinity}
          cooldownTime={Infinity}
          d3VelocityDecay={settings.forces.velocityDecay}
          d3AlphaDecay={0.05}
          warmupTicks={80}
          onRenderFramePre={onRenderFramePre}
          onRenderFramePost={onRenderFramePost}
          onNodeHover={setHoverNode}
          onNodeClick={(node) => {
            if (node?.isHub) {
              onHubClick?.();
              return;
            }
            onSelect?.(node);
            if (fgRef.current) {
              const offsetX = -size.w * 0.12;
              fgRef.current.centerAt(node.x + offsetX / 4, node.y, 800);
              fgRef.current.zoom(2.2, 800);
            }
          }}
          onBackgroundClick={() => onSelect?.(null)}
        />

      {/* Hover ripple */}
      {hoverNode && hoverPos && (
        <HoverRipple
          x={hoverPos.x}
          y={hoverPos.y}
          color={courseColor[hoverNode.course ?? "(none)"] ?? "#94a3b8"}
        />
      )}

      <Legend
        courseColor={courseColor}
        visibleCount={graphData.nodes.filter((n) => !n.isHub).length}
        totalCount={graph.nodes.length}
        linkCount={graphData.links.filter((l) => !l.isHubLink).length}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          courseColor={courseColor}
          onClose={() => setSettingsOpen(false)}
          onResetForces={() =>
            setSettings((s) => ({ ...s, forces: DEFAULT_SETTINGS.forces }))
          }
          onResetAll={() => {
            try { localStorage.removeItem(SETTINGS_STORAGE_KEY); } catch {}
            setSettings(DEFAULT_SETTINGS);
          }}
        />
      )}
    </div>
  );
}

// ============================================================
//  HOVER RIPPLE
// ============================================================
function HoverRipple({ x, y, color }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
        zIndex: 9,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 24,
          height: 24,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
          transform: "translate(-50%, -50%)",
          animation: "ripple 1.6s ease-out infinite",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 24,
          height: 24,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
          transform: "translate(-50%, -50%)",
          animation: "ripple 1.6s ease-out infinite",
          animationDelay: "0.5s",
        }}
      />
      <style>{`
        @keyframes ripple {
          0%   { width: 16px; height: 16px; opacity: 0.9; }
          100% { width: 80px; height: 80px; opacity: 0;   }
        }
      `}</style>
    </div>
  );
}

// ============================================================
//  LEGEND
// ============================================================
function Legend({ courseColor, visibleCount, totalCount, linkCount, onOpenSettings }) {
  const filtered = visibleCount !== totalCount;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 24,
        left: 24,
        background: "var(--panel-strong)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
        backdropFilter: "blur(10px)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        zIndex: 10,
        fontSize: 11,
        color: "var(--text-dim)",
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.04em",
        minWidth: 180,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
          gap: 12,
        }}
      >
        <div
          style={{
            color: filtered ? "var(--accent)" : "var(--text-mute)",
            textTransform: "uppercase",
            fontSize: 10,
            letterSpacing: "0.12em",
          }}
        >
          {filtered
            ? `${visibleCount}/${totalCount} lessons · ${linkCount} links`
            : `${totalCount} lessons · ${linkCount} links`}
        </div>
        <button
          onClick={onOpenSettings}
          title="Graph settings"
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
            cursor: "pointer",
            width: 22,
            height: 22,
            borderRadius: 5,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          ⚙
        </button>
      </div>
      {Object.entries(courseColor).map(([course, color]) => (
        <div
          key={course}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--text)",
            marginTop: 3,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 8px ${hexToRgba(color, 0.6)}`,
              display: "inline-block",
            }}
          />
          {course}
        </div>
      ))}
    </div>
  );
}

// ============================================================
//  SETTINGS PANEL  (Obsidian-style: Filters · Display · Forces)
// ============================================================
function SettingsPanel({ settings, setSettings, courseColor, onClose, onResetForces, onResetAll }) {
  const [tab, setTab] = useState("filters");

  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        left: 24,
        width: 320,
        maxHeight: "calc(100vh - 220px)",
        background: "var(--panel-strong)",
        border: "1px solid var(--border-strong)",
        borderRadius: 12,
        backdropFilter: "blur(14px)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(57,255,20,0.06)",
        zIndex: 12,
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "var(--text-dim)",
          }}
        >
          Graph Settings
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => {
              if (window.confirm("Reset all graph settings to factory defaults?")) {
                onResetAll?.();
              }
            }}
            title="Reset every setting to its factory default"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
              cursor: "pointer",
              padding: "0 8px",
              height: 22,
              borderRadius: 5,
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Reset
          </button>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
              cursor: "pointer",
              width: 22,
              height: 22,
              borderRadius: 5,
              fontSize: 13,
              lineHeight: 1,
              fontFamily: "var(--font-mono)",
            }}
          >
            ×
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 0,
          padding: "8px 12px 0",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {["filters", "display", "forces"].map((id) => (
          <TabBtn key={id} active={tab === id} onClick={() => setTab(id)}>
            {id}
          </TabBtn>
        ))}
      </div>

      <div style={{ overflowY: "auto", padding: 14 }}>
        {tab === "filters" && (
          <FiltersTab settings={settings} setSettings={setSettings} courseColor={courseColor} />
        )}
        {tab === "display" && (
          <DisplayTab
            settings={settings}
            setSettings={setSettings}
          />
        )}
        {tab === "forces" && (
          <ForcesTab
            settings={settings}
            setSettings={setSettings}
            onReset={onResetForces}
          />
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        padding: "8px 12px",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.14em",
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function FiltersTab({ settings, setSettings, courseColor }) {
  const enabled = settings.filters.enabledCourses;
  return (
    <>
      <Field
        label="Search"
        description="Hides nodes whose lesson title, course, or key concepts don't include this text."
      >
        <input
          type="text"
          value={settings.filters.searchTerm}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              filters: { ...s.filters, searchTerm: e.target.value },
            }))
          }
          placeholder="lesson title or concept…"
          style={inputStyle}
        />
      </Field>
      <Field
        label="Courses"
        description="Toggle a course off to hide every lesson in it and any link touching one."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {Object.entries(courseColor).map(([course, color]) => (
            <CheckRow
              key={course}
              checked={enabled[course] !== false}
              onChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  filters: {
                    ...s.filters,
                    enabledCourses: { ...s.filters.enabledCourses, [course]: v },
                  },
                }))
              }
              dot={color}
            >
              {course}
            </CheckRow>
          ))}
        </div>
      </Field>
      <Field
        label={`Min link weight: ${settings.filters.minLinkWeight}`}
        description="Hide weak connections. Higher = only show edges that share many key concepts."
      >
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={settings.filters.minLinkWeight}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              filters: { ...s.filters, minLinkWeight: Number(e.target.value) },
            }))
          }
          style={rangeStyle}
        />
      </Field>
    </>
  );
}

function DisplayTab({ settings, setSettings }) {
  const d = settings.display;
  const set = (k, v) =>
    setSettings((s) => ({ ...s, display: { ...s.display, [k]: v } }));
  return (
    <>
      <CheckRow
        checked={d.showLabels}
        onChange={(v) => set("showLabels", v)}
        description="Renders the lesson title under each node."
      >
        Lesson labels
      </CheckRow>
      <CheckRow
        checked={d.showHulls}
        onChange={(v) => set("showHulls", v)}
        description="Soft glowing blobs grouping each course's nodes."
      >
        Course hulls
      </CheckRow>
      <CheckRow
        checked={d.showStars}
        onChange={(v) => set("showStars", v)}
        description="Faint twinkling stars behind the graph for atmosphere."
      >
        Starfield
      </CheckRow>
      <CheckRow
        checked={d.animatedEdges}
        onChange={(v) => set("animatedEdges", v)}
        description="Dashed pulses that flow along each link from source to target."
      >
        Animated edges
      </CheckRow>
      <CheckRow
        checked={d.aliveness}
        onChange={(v) => set("aliveness", v)}
        description="The whole formation slowly drifts around; halos pulse asynchronously."
      >
        Aliveness (drift + glow)
      </CheckRow>
      <Field
        label={`Node size: ${d.nodeSize.toFixed(2)}×`}
        description="Multiplier on every node's rendered size, on top of the connection-count scaling."
      >
        <input
          type="range"
          min={0.5}
          max={2.5}
          step={0.05}
          value={d.nodeSize}
          onChange={(e) => set("nodeSize", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <Field
        label={`Link thickness: ${d.linkWidth.toFixed(2)}×`}
        description="Multiplier on every link's line width."
      >
        <input
          type="range"
          min={0.3}
          max={3.0}
          step={0.1}
          value={d.linkWidth}
          onChange={(e) => set("linkWidth", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
    </>
  );
}

function ForcesTab({ settings, setSettings, onReset }) {
  const f = settings.forces;
  const set = (k, v) =>
    setSettings((s) => ({ ...s, forces: { ...s.forces, [k]: v } }));
  return (
    <>
      <Field
        label={`Repel force: ${f.chargeStrength}`}
        description="How strongly nodes push each other apart. More negative = stronger repulsion = looser graph."
      >
        <input
          type="range"
          min={-600}
          max={-20}
          step={5}
          value={f.chargeStrength}
          onChange={(e) => set("chargeStrength", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <Field
        label={`Link distance: ${f.linkDistance}`}
        description="The ideal rest length of every link. Higher = connected nodes sit farther apart."
      >
        <input
          type="range"
          min={20}
          max={300}
          step={5}
          value={f.linkDistance}
          onChange={(e) => set("linkDistance", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <Field
        label={`Link strength: ${f.linkStrength.toFixed(2)}`}
        description="How rigidly each link enforces its ideal distance. 0 = no pull, 1 = rigid spring."
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={f.linkStrength}
          onChange={(e) => set("linkStrength", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <Field
        label={`Center force: ${f.centerStrength.toFixed(2)}`}
        description="Constant pull toward origin (0,0). Higher = the graph balls up tighter."
      >
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={f.centerStrength}
          onChange={(e) => set("centerStrength", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <Field
        label={`Symmetry: ${f.symmetryStrength.toFixed(2)}`}
        description="Pulls each course's nodes toward its own angular slot on a ring. Higher = flower-shaped layout."
      >
        <input
          type="range"
          min={0}
          max={0.4}
          step={0.01}
          value={f.symmetryStrength}
          onChange={(e) => set("symmetryStrength", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <Field
        label={`Velocity decay: ${f.velocityDecay.toFixed(2)}`}
        description="Friction. Lower = motion lingers, the graph never sits still. Higher = settles quickly."
      >
        <input
          type="range"
          min={0.05}
          max={0.95}
          step={0.05}
          value={f.velocityDecay}
          onChange={(e) => set("velocityDecay", Number(e.target.value))}
          style={rangeStyle}
        />
      </Field>
      <button
        onClick={onReset}
        style={{
          marginTop: 8,
          background: "transparent",
          border: "1px solid var(--border-strong)",
          color: "var(--text-dim)",
          cursor: "pointer",
          padding: "6px 10px",
          borderRadius: 5,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          width: "100%",
        }}
      >
        Reset forces
      </button>
      <Hint dim>Restores every Forces slider to the tuned default.</Hint>
    </>
  );
}

function Field({ label, description, badge, disabled, children }) {
  return (
    <div style={{ marginBottom: 12, opacity: disabled ? 0.45 : 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "var(--text-mute)",
          }}
        >
          {label}
        </div>
        {badge && <ModeBadge>{badge}</ModeBadge>}
      </div>
      {children}
      {description && <Hint indent={false}>{description}</Hint>}
    </div>
  );
}

function CheckRow({ checked, onChange, children, dot, description, badge, disabled }) {
  return (
    <div style={{ marginBottom: description ? 8 : 0, opacity: disabled ? 0.45 : 1 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 0",
          cursor: disabled ? "default" : "pointer",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => !disabled && onChange(e.target.checked)}
          style={{ accentColor: "#39ff14" }}
          disabled={disabled}
        />
        {dot && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: dot,
              boxShadow: `0 0 6px ${hexToRgba(dot, 0.6)}`,
            }}
          />
        )}
        <span style={{ flex: 1 }}>{children}</span>
        {badge && <ModeBadge>{badge}</ModeBadge>}
      </label>
      {description && <Hint indent>{description}</Hint>}
    </div>
  );
}

function Hint({ children, indent = true, dim = false }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        lineHeight: 1.45,
        color: dim ? "var(--text-mute)" : "var(--text-dim)",
        marginTop: 2,
        marginLeft: indent ? 24 : 0,
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  );
}

function ModeBadge({ children }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--text-mute)",
        background: "rgba(255,255,255,0.06)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

const inputStyle = {
  width: "100%",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
  boxSizing: "border-box",
};

const rangeStyle = {
  width: "100%",
  accentColor: "#39ff14",
  cursor: "pointer",
};

// ============================================================
//  DETAILS PANEL
// ============================================================
function DetailsPanel({ node, onClose, courseColor }) {
  const accent = courseColor[node.course ?? "(none)"] ?? "#94a3b8";
  return (
    <div
      style={{
        position: "absolute",
        top: 80,
        right: 24,
        width: 380,
        maxHeight: "75vh",
        background: "var(--panel-strong)",
        border: "1px solid var(--border-strong)",
        borderRadius: 12,
        padding: 18,
        backdropFilter: "blur(14px)",
        boxShadow: `0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px ${hexToRgba(accent, 0.15)}`,
        zIndex: 10,
        color: "var(--text)",
        fontSize: 13,
        lineHeight: 1.55,
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: hexToRgba(accent, 0.85),
          }}
        >
          {node.course} · WEEK {node.week}
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 18,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          fontSize: 17,
          fontWeight: 600,
          marginBottom: 12,
          letterSpacing: "-0.01em",
        }}
      >
        {node.lesson}
      </div>
      {node.summary && (
        <div style={{ color: "var(--text)", marginBottom: 14, opacity: 0.88 }}>
          {node.summary}
        </div>
      )}
      {node.key_concepts?.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "var(--text-mute)",
              marginBottom: 6,
            }}
          >
            key concepts
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {node.key_concepts.map((c, i) => (
              <span
                key={i}
                style={{
                  background: hexToRgba(accent, 0.1),
                  border: `1px solid ${hexToRgba(accent, 0.3)}`,
                  color: hexToRgba(accent, 0.95),
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {c}
              </span>
            ))}
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

// ============================================================
//  utils
// ============================================================

// Linear interpolate between two #rrggbb (or #rgb) colors. Returns a
// #rrggbb hex string. t is clamped to [0, 1].
function lerpHex(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const A = parseHex(a);
  const B = parseHex(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * k);
  const g = Math.round(A[1] + (B[1] - A[1]) * k);
  const bv = Math.round(A[2] + (B[2] - A[2]) * k);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bv)}`;
}

function parseHex(hex) {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const v =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
