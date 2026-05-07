import { useEffect, useRef, useState } from "react";

export default function ChatPanel() {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState("");
  const [contextEntries, setContextEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const responseRef = useRef(null);

  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [response]);

  async function send() {
    const q = query.trim();
    if (!q || busy) return;

    setBusy(true);
    setDone(false);
    setError(null);
    setResponse("");
    setContextEntries([]);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/advisor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            handleChunk(chunk);
          } catch {
            console.warn("bad chunk", line);
          }
        }
      }
      if (buf.trim()) {
        try {
          handleChunk(JSON.parse(buf));
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleChunk(chunk) {
    if (chunk.type === "context") {
      setContextEntries(chunk.entries ?? []);
    } else if (chunk.type === "token") {
      setResponse((prev) => prev + (chunk.value ?? ""));
    } else if (chunk.type === "error") {
      setError(chunk.message ?? "advisor error");
    } else if (chunk.type === "done") {
      setDone(true);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        paddingTop: 80,
        paddingBottom: 24,
        paddingLeft: 24,
        paddingRight: 24,
        display: "flex",
        flexDirection: "column",
        zIndex: 5,
      }}
    >
      <div
        style={{
          maxWidth: 820,
          width: "100%",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        }}
      >
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask your SOT… e.g. write me a study guide for BE101 week 2"
          rows={3}
          style={{
            padding: "10px 14px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 8,
            color: "white",
            outline: "none",
            fontSize: 14,
            fontFamily: "inherit",
            resize: "vertical",
            boxSizing: "border-box",
          }}
          disabled={busy}
        />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 10,
            gap: 12,
          }}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
            ⌘/Ctrl + Enter to send
          </div>
          <button
            onClick={send}
            disabled={busy || !query.trim()}
            style={{
              padding: "8px 18px",
              background: busy ? "#1e3a8a" : "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
              opacity: busy || !query.trim() ? 0.6 : 1,
            }}
          >
            {busy ? "Thinking…" : "Send"}
          </button>
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              color: "#ef4444",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {contextEntries.length > 0 && (
          <ContextChips entries={contextEntries} />
        )}

        {(response || busy) && (
          <div
            ref={responseRef}
            style={{
              marginTop: 14,
              padding: 16,
              background: "rgba(8,10,16,0.7)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              flex: 1,
              overflowY: "auto",
              color: "rgba(255,255,255,0.92)",
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              minHeight: 100,
            }}
          >
            {response}
            {busy && !done && (
              <span style={{ color: "rgba(255,255,255,0.45)" }}>▍</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ContextChips({ entries }) {
  return (
    <div
      style={{
        marginTop: 12,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.5)",
          marginRight: 4,
        }}
      >
        Using {entries.length} entr{entries.length === 1 ? "y" : "ies"}
      </span>
      {entries.map((e) => (
        <span
          key={e.event_id}
          title={`${e.course} · week ${e.week} — ${e.lesson}`}
          style={{
            display: "inline-block",
            padding: "3px 8px",
            background: "rgba(59,130,246,0.15)",
            border: "1px solid rgba(59,130,246,0.35)",
            borderRadius: 999,
            fontSize: 11,
            color: "rgba(255,255,255,0.85)",
            maxWidth: 280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {e.course} w{e.week} · {e.lesson}
        </span>
      ))}
    </div>
  );
}
