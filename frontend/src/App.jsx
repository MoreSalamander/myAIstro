/**
 * App.jsx — the top-level React component.
 *
 * Responsibilities:
 *   - Switch between the five main panels (Graph, List, Archives,
 *     Classroom, About) via the `view` state.
 *   - Manage four modal flows (Ingest, Quiz, my-AI-stro Chat, General
 *     Chat) layered on top of any panel.
 *   - Track write-protection state — whether the backend has a write
 *     password configured, and whether this browser has unlocked.
 *   - Record visits exactly once per app mount (StrictMode-safe via a
 *     ref guard), with a per-browser stable UUID for unique-visitor
 *     counting.
 *   - Surface the LessonDrawer when an entry is selected from any panel.
 *
 * Routing model:
 *   - First-time visitors land on the About panel (so they orient
 *     themselves before exploring). Anyone whose visitor_id is already
 *     in localStorage defaults to the Graph view.
 *   - `dataVersion` increments after every successful ingest; live
 *     views (Graph, List, Archives) watch it and re-fetch.
 *
 * What this file is NOT:
 *   - Not state-management heavy. No Redux/Zustand/etc. — local React
 *     state plus a small amount of localStorage is enough for a
 *     single-user app.
 *   - Not a router. The five views are component switching, not URL
 *     routes. Deep links happen via the LessonDrawer's lesson lookup.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import IngestPanel from "./components/IngestPanel";
import SotBrowser from "./components/SotBrowser";
import QuizPanel from "./components/QuizPanel";
import ChatPanel from "./components/ChatPanel";
import GraphPanel from "./components/GraphPanel";
import LessonDrawer from "./components/LessonDrawer";
import ArchivesPanel from "./components/ArchivesPanel";
import ClassroomPanel from "./components/classroom/ClassroomPanel";
import NotebookPanel from "./components/NotebookPanel";
import AboutPanel from "./components/AboutPanel";
import {
  getStoredWritePassword,
  setStoredWritePassword,
  clearStoredWritePassword,
} from "./lib/writeAuth";

// Feature flag — set VITE_CLASSROOM_ENABLED=false in .env.local to hide
// the Classroom tab entirely without removing code. Default on.
const CLASSROOM_ENABLED =
  import.meta.env.VITE_CLASSROOM_ENABLED !== "false";

export default function App() {
  // First-time visitors land on About so they orient themselves before
  // exploring. Returning users (anyone whose visitor_id is already in
  // localStorage) default to the graph. The visitor_id gets set on
  // first mount as part of the visit counter, so the "About first"
  // route only fires once per browser.
  const [view, setView] = useState(() => {
    try {
      if (localStorage.getItem("myaistro_visitor_id")) return "map";
    } catch {
      /* localStorage blocked — fall through */
    }
    return "about";
  }); // "map" | "list" | "notebook" | "archives" | "classroom" | "about"
  const [classroomPresetEntry, setClassroomPresetEntry] = useState(null);
  // Preset for the new Notebook → Classroom flow. Carries the
  // notebook_id + section_index that ClassroomPanel uses to call
  // /api/classroom/plan-from-section. Cleared once consumed.
  const [classroomPresetSection, setClassroomPresetSection] = useState(null);
  const [selected, setSelected] = useState(null); // graph node or list entry
  const [modal, setModal] = useState(null); // null | "ingest" | "quiz" | "advisor" | "general"
  const [modalLesson, setModalLesson] = useState(null);
  const [stats, setStats] = useState(null);
  // Bumped each time a lesson is successfully ingested. Live views (graph,
  // list) read this and re-fetch when it changes.
  const [dataVersion, setDataVersion] = useState(0);
  // Write-protection state. `writeProtected` reflects backend env var;
  // `unlocked` is whether THIS client has a stored password.
  const [writeProtected, setWriteProtected] = useState(false);
  const [unlocked, setUnlocked] = useState(!!getStoredWritePassword());
  const visitSentRef = useRef(false);

  const refreshStats = useCallback(async () => {
    try {
      const r = await fetch("/api/stats");
      if (!r.ok) return;
      setStats(await r.json());
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    refreshStats();
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setWriteProtected(!!data.enabled);
      })
      .catch(() => {});

    // Record this page-load exactly once per app mount. A ref guard
    // prevents StrictMode double-invocation from inflating the count.
    if (!visitSentRef.current) {
      visitSentRef.current = true;
      let cid = "";
      try {
        cid = localStorage.getItem("myaistro_visitor_id") || "";
        if (!cid) {
          cid =
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : Math.random().toString(36).slice(2) +
                Date.now().toString(36);
          localStorage.setItem("myaistro_visitor_id", cid);
        }
      } catch {
        /* localStorage blocked — visit still counted, just non-unique */
      }
      fetch("/api/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cid }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then(() => refreshStats())   // immediately reflect new count
        .catch(() => {});
    }
  }, [refreshStats]);

  const onUnlock = useCallback(() => {
    const pw = window.prompt(
      "Enter the write password to enable Ingest / Re-summarize / Sync:",
      getStoredWritePassword(),
    );
    if (pw === null) return; // user cancelled
    setStoredWritePassword(pw.trim());
    setUnlocked(!!pw.trim());
  }, []);

  const onLock = useCallback(() => {
    clearStoredWritePassword();
    setUnlocked(false);
  }, []);

  const onIngestSuccess = useCallback(() => {
    refreshStats();
    setDataVersion((v) => v + 1);
  }, [refreshStats]);

  const openLesson = useCallback((entry) => {
    setSelected(entry);
  }, []);

  const closeLesson = useCallback(() => setSelected(null), []);

  const openModal = useCallback((kind, lesson = null) => {
    setModal(kind);
    setModalLesson(lesson);
  }, []);
  const closeModal = useCallback(() => {
    setModal(null);
    setModalLesson(null);
    refreshStats(); // ingest may have added a lesson
  }, [refreshStats]);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        position: "relative",
        overflow: "hidden",
        color: "var(--text)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <Header
        view={view}
        setView={setView}
        stats={stats}
        onIngest={() => openModal("ingest")}
        writeProtected={writeProtected}
        unlocked={unlocked}
        onUnlock={onUnlock}
        onLock={onLock}
      />

      <div
        style={{
          position: "absolute",
          top: 160,        // start below the header so nothing renders behind it
          right: 0,
          bottom: 0,
          left: 0,
          zIndex: 1,
        }}
      >
        {view === "map" && (
          <GraphPanel
            onSelect={openLesson}
            selectedId={selected?.id ?? selected?.event_id ?? null}
            dataVersion={dataVersion}
            onHubClick={() => openModal("advisor")}
          />
        )}
        {view === "list" && (
          <SotBrowser onSelect={openLesson} dataVersion={dataVersion} />
        )}
        {view === "notebook" && (
          <NotebookPanel
            onSelectLesson={openLesson}
            dataVersion={dataVersion}
            onTeachSection={(payload) => {
              setClassroomPresetSection(payload);
              setView("classroom");
            }}
          />
        )}
        {view === "archives" && <ArchivesPanel dataVersion={dataVersion} />}
        {view === "classroom" && CLASSROOM_ENABLED && (
          <ClassroomPanel
            presetEntry={classroomPresetEntry}
            onClearPreset={() => setClassroomPresetEntry(null)}
            presetSection={classroomPresetSection}
            onClearPresetSection={() => setClassroomPresetSection(null)}
            isOwner={!writeProtected || unlocked}
          />
        )}
        {view === "about" && <AboutPanel />}
      </div>

      <LessonDrawer
        entry={selected}
        onClose={closeLesson}
        onQuiz={(e) => openModal("quiz", e)}
        onChat={(e) => openModal("advisor", e)}
        onTeach={
          CLASSROOM_ENABLED
            ? (e) => {
                setClassroomPresetEntry(e);
                setView("classroom");
                closeLesson();
              }
            : undefined
        }
      />

      <FloatingActions
        onAdvisor={() => openModal("advisor")}
        onGeneralChat={() => openModal("general")}
        onQuiz={() => openModal("quiz")}
      />

      {modal === "ingest" && (
        <Modal onClose={closeModal} title="Ingest a lesson">
          <IngestPanel embedded onIngested={onIngestSuccess} />
        </Modal>
      )}
      {modal === "quiz" && (
        <Modal onClose={closeModal} title={modalLesson ? `Quiz: ${modalLesson.lesson}` : "Quiz"}>
          <QuizPanel embedded presetEventId={modalLesson?.id ?? modalLesson?.event_id} />
        </Modal>
      )}
      {modal === "advisor" && (
        <Modal onClose={closeModal} title={modalLesson ? `my-AI-stro Chat · ${modalLesson.lesson}` : "my-AI-stro Chat"}>
          <ChatPanel embedded mode="advisor" seedLesson={modalLesson} />
        </Modal>
      )}
      {modal === "general" && (
        <Modal onClose={closeModal} title="General Chat · llama3.2">
          <ChatPanel embedded mode="general" />
        </Modal>
      )}
    </div>
  );
}

// ============================================================
//  HEADER  (brand · today strip · view toggle)
// ============================================================
/**
 * Header — the persistent top strip of the app. Three regions:
 *   - left:   TodayStrip (course/lesson/visitor counts) and, when
 *             write-protection is active, the WriteLockChip
 *   - center: BrandMark (logo + "my-AI-stro" wordmark)
 *   - right:  ViewToggle (the five-panel switcher) plus the floating
 *             "+" Ingest button when unlocked
 *
 * The header has `pointerEvents: none` on its container so the gradient
 * fade behind it doesn't intercept clicks meant for the graph; each
 * interactive child re-enables pointerEvents on itself.
 *
 * @param {object}   props
 * @param {string}   props.view              Current panel ('map' | 'list' | 'archives' | 'classroom' | 'about')
 * @param {Function} props.setView           View switcher
 * @param {object}   props.stats             Today-strip data from /api/stats
 * @param {Function} props.onIngest          Click handler for the "+" Ingest button
 * @param {boolean}  props.writeProtected    Whether the backend has a password configured
 * @param {boolean}  props.unlocked          Whether this browser has unlocked writes
 * @param {Function} props.onUnlock          Prompt-for-password handler
 * @param {Function} props.onLock            Clear stored password
 */
function Header({
  view,
  setView,
  stats,
  onIngest,
  writeProtected,
  unlocked,
  onUnlock,
  onLock,
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 160,
        zIndex: 30,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "16px 24px 0",
        background:
          "linear-gradient(to bottom, rgba(4,6,10,0.92), rgba(4,6,10,0))",
        backdropFilter: "blur(8px)",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <TodayStrip stats={stats} />
        {writeProtected && (
          <WriteLockChip unlocked={unlocked} onUnlock={onUnlock} onLock={onLock} />
        )}
      </div>
      <BrandMark />
      <ViewToggle view={view} setView={setView} onIngest={onIngest} />
    </div>
  );
}

function WriteLockChip({ unlocked, onUnlock, onLock }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={unlocked ? onLock : onUnlock}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        unlocked
          ? "Writes unlocked on this device — click to lock"
          : "Writes are locked — click to enter the password"
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        background: unlocked ? "var(--accent-bg)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${unlocked ? "var(--accent-soft)" : "var(--border-strong)"}`,
        borderRadius: 999,
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: unlocked ? "var(--accent)" : "var(--text-dim)",
        pointerEvents: "auto",
        boxShadow:
          unlocked && hover ? "0 0 14px var(--accent-glow)" : "none",
        transition: "background 0.15s, box-shadow 0.2s",
      }}
    >
      <span style={{ fontSize: 11 }}>{unlocked ? "🔓" : "🔒"}</span>
      {unlocked ? "Writes Unlocked" : "Writes Locked"}
    </button>
  );
}

function BrandMark() {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: 18,
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        userSelect: "none",
        pointerEvents: "auto",
        whiteSpace: "nowrap",
      }}
    >
      <Logo />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "clamp(28px, 3.4vw, 44px)",
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: "var(--text)",
          textShadow: "0 0 24px rgba(57,255,20,0.25)",
          lineHeight: 1,
        }}
      >
        <span style={{ color: "var(--text-dim)" }}>my</span>
        <span style={{ color: "var(--text-mute)", margin: "0 2px" }}>-</span>
        <span style={{ color: "var(--accent)" }}>AI</span>
        <span style={{ color: "var(--text-mute)", margin: "0 2px" }}>-</span>
        <span style={{ color: "var(--text-dim)" }}>stro</span>
      </span>
    </div>
  );
}

function Logo() {
  // Concentric rings + a pulsing core dot — feels like a node on the
  // graph, hinting that the whole app is one big knowledge map.
  return (
    <div
      style={{
        position: "relative",
        width: 44,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: "1px solid rgba(57,255,20,0.3)",
        }}
      />
      <span
        style={{
          position: "absolute",
          inset: 8,
          borderRadius: "50%",
          border: "1px solid rgba(57,255,20,0.55)",
        }}
      />
      <span
        className="glow-pulse"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "var(--accent)",
        }}
      />
    </div>
  );
}

function TodayStrip({ stats }) {
  if (!stats) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 18,
        alignItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-dim)",
        letterSpacing: "0.04em",
        pointerEvents: "auto",
      }}
    >
      <Stat
        label="Courses"
        value={stats.by_course ? Object.keys(stats.by_course).length : 0}
        title={
          stats.by_course
            ? Object.entries(stats.by_course)
                .map(([c, n]) => `${c}: ${n}`)
                .join("\n")
            : undefined
        }
      />
      <Stat label="Lessons" value={stats.total ?? 0} />
      {stats.visits && (
        <Stat
          label="Visitors"
          value={`${stats.visits.unique}`}
          title={`${stats.visits.unique} unique browsers · ${stats.visits.total} total page loads`}
        />
      )}
    </div>
  );
}

function Stat({ label, value, accent, title }) {
  return (
    <div
      title={title}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        lineHeight: 1.1,
      }}
    >
      <span
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          color: "var(--text-mute)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          color: accent ? "var(--accent)" : "var(--text)",
          fontWeight: 500,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ViewToggle({ view, setView, onIngest }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        pointerEvents: "auto",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--accent)",
          textShadow: "0 0 16px var(--accent-glow)",
          whiteSpace: "nowrap",
        }}
      >
        Sources Of Truth
      </span>
      <div
        style={{
          display: "flex",
          gap: 0,
          background: "var(--panel-strong)",
          padding: 3,
          borderRadius: 8,
          border: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <ToggleSeg active={view === "map"} onClick={() => setView("map")}>
          Graph
        </ToggleSeg>
        <ToggleSeg active={view === "list"} onClick={() => setView("list")}>
          List
        </ToggleSeg>
        <ToggleSeg active={view === "notebook"} onClick={() => setView("notebook")}>
          Notebook
        </ToggleSeg>
        <ToggleSeg active={view === "archives"} onClick={() => setView("archives")}>
          Archives
        </ToggleSeg>
        {CLASSROOM_ENABLED && (
          <ToggleSeg
            active={view === "classroom"}
            onClick={() => setView("classroom")}
          >
            Classroom
          </ToggleSeg>
        )}
        <ToggleSeg active={view === "about"} onClick={() => setView("about")}>
          About
        </ToggleSeg>
      </div>
      {onIngest && <FAB title="Ingest a lesson" onClick={onIngest} icon="+" primary />}
    </div>
  );
}

function ToggleSeg({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px",
        background: active ? "var(--accent-bg)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-dim)",
        border: active ? "1px solid var(--accent-soft)" : "1px solid transparent",
        borderRadius: 5,
        cursor: "pointer",
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        fontFamily: "inherit",
        boxShadow: active ? "0 0 12px var(--accent-glow)" : "none",
        transition: "background 0.15s, color 0.15s, box-shadow 0.2s",
      }}
    >
      {children}
    </button>
  );
}

// ============================================================
//  FLOATING ACTIONS  (bottom-right action stack)
// ============================================================
/**
 * FloatingActions — the bottom-right stack of action pills. Three
 * buttons: my-AI-stro Chat (SOT-grounded advisor), General Chat
 * (untethered llama3.2 — explicitly NOT the summarization model), and
 * Quiz Me (recall test on a SOT entry).
 *
 * The two chat buttons are deliberately styled differently — my-AI-stro
 * Chat in the accent green of the SOT, General Chat in yellow to signal
 * "off the leash, no grounding."
 *
 * @param {object}   props
 * @param {Function} props.onAdvisor      Open the SOT-grounded chat modal
 * @param {Function} props.onGeneralChat  Open the untethered general-chat modal
 * @param {Function} props.onQuiz         Open the quiz modal
 */
function FloatingActions({ onAdvisor, onGeneralChat, onQuiz }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 24,
        right: 24,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 10,
        zIndex: 25,
      }}
    >
      <PillBtn title="Take a quiz on a lesson" onClick={onQuiz} icon="?">
        Quiz Me
      </PillBtn>
      <PillBtn
        title="Free-form chat (llama3.2, no SOT — explicitly NOT the summarization model)"
        onClick={onGeneralChat}
        icon="✦"
        prominent
        tone="yellow"
      >
        General Chat
      </PillBtn>
      <PillBtn
        title="Talk to your SOT-grounded chat"
        onClick={onAdvisor}
        icon="◉"
        prominent
      >
        my-AI-stro Chat
      </PillBtn>
    </div>
  );
}

function PillBtn({ title, onClick, icon, children, prominent, tone = "green" }) {
  const [hover, setHover] = useState(false);
  const palette =
    tone === "yellow"
      ? {
          accent: "var(--accent-yellow)",
          soft: "var(--accent-yellow-soft)",
          glow: "var(--accent-yellow-glow)",
          bg: "var(--accent-yellow-bg)",
          ring: "rgba(247,255,0,0.18)",
          iconBg: "rgba(247,255,0,0.18)",
          textOnHover: "#1a1a00",
        }
      : {
          accent: "var(--accent)",
          soft: "var(--accent-soft)",
          glow: "var(--accent-glow)",
          bg: "var(--accent-bg)",
          ring: "rgba(57,255,20,0.18)",
          iconBg: "rgba(57,255,20,0.18)",
          textOnHover: "#001a05",
        };
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: prominent ? 10 : 8,
        padding: prominent ? "11px 18px" : "8px 14px",
        background: prominent
          ? hover
            ? palette.accent
            : palette.bg
          : hover
          ? "var(--panel-strong)"
          : "var(--panel)",
        color: prominent
          ? hover
            ? palette.textOnHover
            : palette.accent
          : hover
          ? "var(--text)"
          : "var(--text-dim)",
        border: prominent ? `1px solid ${palette.soft}` : "1px solid var(--border-strong)",
        borderRadius: 999,
        cursor: "pointer",
        fontSize: prominent ? 13 : 11,
        fontWeight: prominent ? 600 : 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontFamily: "var(--font-mono)",
        boxShadow: prominent
          ? hover
            ? `0 0 36px ${palette.glow}, 0 0 0 4px ${palette.ring}`
            : `0 0 24px ${palette.glow}`
          : "0 4px 16px rgba(0,0,0,0.4)",
        backdropFilter: "blur(10px)",
        transition:
          "background 0.15s, color 0.15s, box-shadow 0.2s, transform 0.15s",
        transform: hover ? "scale(1.04)" : "scale(1)",
      }}
    >
      <span
        style={{
          width: prominent ? 22 : 18,
          height: prominent ? 22 : 18,
          borderRadius: "50%",
          background: prominent
            ? hover
              ? "rgba(0,0,0,0.2)"
              : palette.iconBg
            : "rgba(255,255,255,0.06)",
          border: prominent ? "none" : "1px solid var(--border)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: prominent ? 13 : 11,
        }}
      >
        {icon}
      </span>
      <span>{children}</span>
    </button>
  );
}

function FAB({ title, onClick, icon, primary }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: primary ? 52 : 42,
        height: primary ? 52 : 42,
        borderRadius: "50%",
        background: primary
          ? hover
            ? "var(--accent)"
            : "var(--accent-bg)"
          : hover
          ? "var(--panel-strong)"
          : "var(--panel)",
        color: primary
          ? hover
            ? "#000"
            : "var(--accent)"
          : "var(--text)",
        border: primary
          ? "1px solid var(--accent-soft)"
          : "1px solid var(--border-strong)",
        cursor: "pointer",
        fontSize: primary ? 24 : 16,
        fontFamily: "var(--font-mono)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: primary
          ? hover
            ? "0 0 28px var(--accent-glow), 0 0 0 4px rgba(57,255,20,0.15)"
            : "0 0 16px var(--accent-glow)"
          : "0 4px 16px rgba(0,0,0,0.4)",
        backdropFilter: "blur(10px)",
        transition: "background 0.15s, color 0.15s, box-shadow 0.2s, transform 0.15s",
        transform: hover ? "scale(1.06)" : "scale(1)",
      }}
    >
      {icon}
    </button>
  );
}

// ============================================================
//  MODAL OVERLAY
// ============================================================
/**
 * Modal — generic overlay used by Ingest, Quiz, and the two chat
 * modes. Escape closes it; clicking the backdrop closes it; clicking
 * inside the modal body does not. The body is a full-height flex
 * container with a header (title + close button) and a scrollable
 * content area below.
 *
 * @param {object}   props
 * @param {React.ReactNode} props.children  Rendered inside the body
 * @param {Function} props.onClose          Called on Escape, backdrop click, or × button
 * @param {string}   props.title            Header label (uppercased + spaced)
 */
function Modal({ children, onClose, title }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2,4,8,0.72)",
        backdropFilter: "blur(8px)",
        zIndex: 50,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        padding: "60px 40px 40px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 980,
          height: "100%",
          background: "var(--panel-strong)",
          border: "1px solid var(--border-strong)",
          borderRadius: 14,
          boxShadow: "0 20px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(57,255,20,0.06)",
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
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "var(--text-dim)",
            }}
          >
            {title}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
              cursor: "pointer",
              width: 28,
              height: 28,
              borderRadius: 6,
              fontSize: 16,
              lineHeight: 1,
              fontFamily: "var(--font-mono)",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
