/**
 * AboutPanel — the in-app product explainer.
 *
 * One long-scroll page covering my-AI-stro end-to-end: what it is,
 * the SOT abstraction, the ingestion pipeline, the agents, the
 * self-improving audit loop, the graph, the four interaction modes,
 * the local-first stance, sharing posture, and the discipline of
 * what's deliberately not here.
 *
 * Voice matches the Archives intro: plain prose, confident, technical
 * specifics where they earn their place. Visuals are minimal — one
 * pipeline flow diagram, one agent table; the rest is typography.
 */

export default function AboutPanel() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflowY: "auto",
        zIndex: 5,
      }}
    >
      <div
        style={{
          maxWidth: 780,
          margin: "0 auto",
          padding: "32px 28px 80px",
          color: "var(--text)",
          fontSize: 15,
          lineHeight: 1.65,
        }}
      >
        <Hero />

        <Section title="The Source of Truth">
          <p>
            Everything in my-AI-stro orbits one data abstraction: the{" "}
            <strong>Source of Truth</strong>, or SOT.
          </p>
          <p>
            A SOT entry is the canonical record of one lesson. It holds the
            raw text you pasted in, plus everything extracted from it — a
            prose summary, a list of key concepts, term-definition pairs,
            verbatim code blocks, validation metadata, and timestamps.
            Entries are stored under the key{" "}
            <Code>(course, week, lesson)</Code>, so re-ingesting the same
            lesson replaces the old record cleanly.
          </p>
          <p>
            A single lesson can have <strong>multiple active versions</strong>{" "}
            — that's how the self-improving loop works (see below). The
            oldest active version is always <strong>canonical</strong> — what
            every other surface in the app reads. Newer versions live in the
            background, get scored, and either become canonical themselves or
            land in the Archives.
          </p>
          <p>
            The SOT is one JSON file on your Mac. No database. No cloud
            sync. Atomic writes so a crash mid-write can't corrupt anything.
          </p>
        </Section>

        <Section title="How a lesson becomes part of my-AI-stro">
          <p>
            When you paste a lesson into the Ingest modal, it travels a
            five-stage pipeline before joining the SOT:
          </p>

          <PipelineDiagram
            stages={[
              "graph_entry",
              "retrieval",
              "summarization",
              "validation",
              "memory_write",
            ]}
          />

          <p>
            <strong>Graph entry</strong> records the trace and timestamp.{" "}
            <strong>Retrieval</strong> is currently a pass-through (kept for
            future context-aware ingestion).{" "}
            <strong>Summarization</strong> is the heavy lift: the raw text
            goes to llama3:8b with a tight prompt that returns structured
            JSON with defenses layered against every captured failure mode.{" "}
            <strong>Validation</strong> is the gatekeeper — a pure-Python
            rule-based check that rejects raw-JSON-as-summary, requires
            key concepts on non-trivial lessons, and inspects each
            extracted item against the raw lesson. Key concepts and
            definitions that don't appear as a substring (or even a
            shared token of four-plus characters) in the source get
            dropped before write — hallucinated bullets never enter the
            SOT. If more than 60% of the extracted items fail the
            grounding check, the whole entry is rejected. Failures
            don't write. <strong>Memory write</strong> commits the
            entry, syncs the Obsidian vault mirror, and emits a
            completion event.
          </p>
          <p>
            The whole pipeline streams back as NDJSON so you watch each
            stage light up live on the data-flow canvas. If validation
            fails, the entry is rejected with the specific errors logged.
          </p>
        </Section>

        <Section title="The agents at work">
          <p>
            my-AI-stro has eleven named agents. Each does exactly one thing.
          </p>
          <AgentTable />
          <p>
            Three design principles in that roster worth naming explicitly.
            First, <strong>LLM-as-judge separation</strong>: the model
            that generates a thing is never the model that grades it
            (Quiz uses llama3.2 to generate questions and mistral to
            grade your answers). Second,{" "}
            <strong>deterministic where deterministic is honest</strong>:
            validation and audit scoring are pure Python. No model
            variance gets to decide whether an entry survives. Third,{" "}
            <strong>trust isolation around the SOT</strong>: the model
            responsible for summarizing lessons into the canonical
            knowledge base does only that. It doesn't also handle
            ungrounded general chat. Ollama calls are stateless, so the
            cost of sharing weights wouldn't be runtime — it would be
            epistemic. The "this entry was carefully extracted" claim
            is stronger when the same weights aren't also free-
            associating elsewhere in the app.
          </p>
        </Section>

        <Section title="The deterministic scaffold">
          <p>
            Four of the eleven agents above don't run an LLM at all.
            Neither does the orchestrator that runs them. That's
            deliberate: every LLM call in my-AI-stro is wrapped in a
            deterministic Python fence that decides what to do with its
            output.
          </p>
          <p>
            <strong>Validation</strong> is the gate between summarization
            and the SOT. A pure-Python function with rule checks against
            the raw lesson: rejects raw-JSON-as-summary (a known LLM
            fallback failure), requires key concepts on non-trivial
            lessons, requires substantive summary length, and — the
            strongest defense — inspects every extracted key concept
            and definition against the raw lesson text. Items that
            don't appear as a substring (or share at least one
            four-plus-character token) get dropped before write;
            entries where more than 60% of items fail that check are
            rejected outright. Hallucinated bullets never enter the
            SOT.
          </p>
          <p>
            <strong>The Judge</strong> is the gate between the audit
            cycle's alternative versions and what stays canonical.
            Originally an LLM (mistral); in practice mistral returned
            10/10 for nearly every summary regardless of measurable
            quality differences, defeating the entire audit cycle. The
            pure-Python rewrite scores each version on a fixed formula:
          </p>
          <FormulaBlock>
{`score = grounded_kc   × 5   −  ungrounded_kc   × 2
      + grounded_defs × 3   −  ungrounded_defs × 1
      + code_blocks   × 2
      + min(summary_len, 800) × 0.05`}
          </FormulaBlock>
          <p>
            Same inputs, same score, every time. No model drift. No
            Ollama call. Ungrounded items don't just fail to add —
            they subtract. Padding the summary with concepts the lesson
            never mentions can't beat staying anchored to the source,
            and the math says so plainly.
          </p>
          <p>
            <strong>The orchestrator</strong> runs the five-stage
            ingestion pipeline as a fixed sequence with typed event
            handoffs. Each stage produces an event the next stage
            consumes. If validation fails, memory_write never runs. If
            summarization throws, the pipeline halts and the error is
            preserved for the user to see. There is no "agent loop"
            choosing what to do next — the control flow is a switch
            statement. The audit loop is the same shape: pick the next
            lesson, route to score-and-archive vs. create-new-version,
            suppress churning lessons, skip stable groups. The
            decisions are control flow; the LLM is summoned only when
            it has something useful to do.
          </p>
          <p>
            The read side runs the same shape — see{" "}
            <em>The advisor pipeline</em> below for the full breakdown.
            Both pipelines emit identical NDJSON event vocabularies;
            both ride the same observability layer in the UI. The
            pattern is now used twice, deliberately.
          </p>
          <p>
            <strong>Memory Writer</strong> is the gate to the file
            system itself. Atomic temp-file-and-rename writes so a
            crash mid-write can't corrupt the SOT. Upsert by{" "}
            <Code>(course, week, lesson)</Code> so re-ingesting cleans
            up rather than duplicating. Obsidian vault sync as a side
            effect after successful commit, never before.
          </p>
          <p>
            The scaffold is where the system gets its reliability. The
            LLM generates — fluently, usefully, occasionally with
            material that wasn't in the lesson. The deterministic gates
            around it decide what survives: validation refuses bad
            output, the Judge picks between alternatives, the
            orchestrator decides when the model runs at all, Memory
            Writer commits only what made it through every prior check.
            The system doesn't trust any single LLM call. It trusts the
            structure those calls flow through.
          </p>
        </Section>

        <Section title="The self-improving audit loop">
          <p>
            Most personal-knowledge tools treat the first capture of a
            lesson as final. my-AI-stro doesn't. Every 15 minutes, the
            audit agent picks a lesson with room to grow, runs its{" "}
            <Code>raw_text</Code> back through the summarization pipeline,
            and appends a new version of the same lesson to the SOT.
          </p>
          <p>
            When a lesson accumulates three active versions, the Judge
            (the deterministic scorer described above) ranks all three.
            The weakest goes to the Archives — but only when there's a
            clear winner. If the bottom two scores sit within five
            points of each other, the audit recognizes the model has
            converged and leaves the group alone: no archive, no
            re-roll, no wasted compute on a near-tie. If a lesson has
            been archived more than once in the last 24 hours, it gets
            suppressed until the window slides. The loop refuses to
            churn lessons it can't improve.
          </p>
          <p>
            Because the oldest active version is canonical (what every
            other surface reads), the system naturally rotates toward
            richer, more-grounded summaries over time as weaker
            originals get archived. You don't tune it. You don't tell
            it which version is better. It just runs.
          </p>
          <p>
            What you have is a knowledge representation that quietly
            gets denser the longer it sits on your machine, and stops
            trying when it's already as dense as the source allows. The
            Archives tab is the record of that process — there's a{" "}
            <strong>Run audit step</strong> button there if you want to
            fast-forward one cycle and watch the judge work.
          </p>
        </Section>

        <Section title="The advisor pipeline">
          <p>
            my-AI-stro Chat — the natural-language query interface over
            your SOT — runs on its own pipeline, architecturally
            parallel to the ingestion pipeline. Same streaming-NDJSON
            event model, same stage-by-stage discipline. Where
            ingestion turns raw text into one validated SOT entry, the
            advisor turns one user question into a study guide
            assembled from N entries.
          </p>
          <p>
            Each query flows through a fixed sequence:
          </p>
          <PipelineDiagram
            stages={[
              "retrieval",
              "arc",
              "section ×N",
              "recap",
              "assembly",
            ]}
          />
          <p>
            <strong>Retrieval</strong> selects relevant canonical SOT
            entries via course/week-aware filtering plus keyword
            overlap. Audit-generated satellites are filtered out —
            the advisor never weighs duplicate versions of the same
            lesson.{" "}
            <strong>Arc</strong> is one focused LLM call that reads
            the matched lesson list and writes a 2-4 sentence opening
            paragraph naming the conceptual journey across the
            lessons; skipped for single-entry queries.{" "}
            <strong>Section ×N</strong> is the map step — one LLM
            call per retrieved entry, each producing a single
            study-guide section with markdown header, key concepts,
            definitions, and verbatim code samples.{" "}
            <strong>Recap</strong> mirrors the arc at the other end:
            a short closing paragraph naming what the user should now
            understand.{" "}
            <strong>Assembly</strong> is pure Python — string
            concatenation of the streamed tokens in arrival order.
            No second LLM call.
          </p>
          <p>
            <strong>Why per-section instead of one big LLM call?</strong>{" "}
            The previous single-shot design fed all N entries to one
            call with a fixed output budget and produced three
            measurable failure modes. Code samples got compressed
            away — heavy in tokens, easy to cut. Per-lesson grounding
            occasionally drifted, e.g. the model once inverted a "use
            stable id, not array index" lesson into its opposite. And
            depth-per-lesson was uneven, depending on what the model
            chose to compress. Per-section processing fixes all three:
            each lesson gets its own output budget, each section's
            prompt sees only that one lesson so grounding errors stay
            localized, and the structure is consistent run-to-run
            because every section runs the same template.
          </p>
          <p>
            <strong>Why deterministic assembly instead of an LLM reduce?</strong>{" "}
            The arc and recap are LLM calls, but they're scoped
            reduces — each works only from the lesson list (titles +
            summaries), never from the per-section content. A bad arc
            or recap affects only that one paragraph; sections are
            unaffected. Final assembly is pure Python. A reduce step
            that read all N sections would be exactly the place to
            hallucinate cross-lesson claims the system has no source
            for — so the system doesn't take that risk.
          </p>
          <p>
            <strong>The architectural unification matters.</strong>{" "}
            Both pipelines emit the same event vocabulary
            (<Code>step_start</Code>, <Code>step_complete</Code>,{" "}
            <Code>token</Code>, <Code>done</Code>,{" "}
            <Code>error</Code>). Both ride the same observability
            layer in the UI — the ingest pipeline lights up the Data
            Flow canvas; the advisor pipeline drives a live staging
            strip showing "section 3 of 9 · Conditional rendering"
            above the response. The pattern is now used twice,
            deliberately. When a third streaming multi-stage
            operation appears — batch re-summarization, course-wide
            re-grounding, anything that fits the shape — it plugs in
            at the same event model. The first use was scaffolding;
            the second use proves it's a system pattern.
          </p>
        </Section>

        <Section title="The graph, decoded">
          <p>
            The Graph view is the home of my-AI-stro. What you're looking
            at:
          </p>
          <ul style={listStyle}>
            <li>
              A central <strong>black orb glowing white</strong> at the
              origin: the my-AI-stro Chat hub. Click it to open a chat
              across your entire SOT.
            </li>
            <li>
              <strong>Black orbs with course-colored halos</strong> orbiting
              around it — one per lesson. Course identity reads through the
              halo. Bigger halos mean more concept-link connections to other
              lessons.
            </li>
            <li>
              <strong>Gradient links</strong> between orbs, colored from one
              course's accent at one end to the other course's accent at
              the other. Cross-course bridges become visually obvious — you
              can see where backend and frontend lessons share concepts.
            </li>
            <li>
              <strong>Smaller, dim satellite orbs tethered to a canonical
              </strong> by a faint dashed line: the audit agent's
              alternative-version summaries. They follow their canonical
              around as it orbits.
            </li>
            <li>
              <strong>A faint outer ring</strong> marks the boundary of
              the graph. Together with the hub's inner exclusion zone,
              it gives the layout a disc shape rather than a sprawl —
              two soft elastic walls that keep everything contained
              without snapping nodes into a rigid grid.
            </li>
            <li>
              <strong>Heartbeat pulses every 3.7 seconds</strong>: comets
              stream out from the hub to every lesson, cascade in
              course-colored comets along the concept-link network, and
              return to the hub — one continuous wave per cycle, with no
              overlap between waves. A circulatory system of your
              knowledge.
            </li>
          </ul>
          <p>
            Every visual choice carries meaning. Nothing on the graph is
            ornamental.
          </p>
        </Section>

        <Section title="Five ways to interact with your knowledge">
          <p>
            Once a lesson is in the SOT, you have five ways to engage with
            it:
          </p>
          <ul style={listStyle}>
            <li>
              <strong>List view</strong> — read it. The structured summary,
              key concepts, definitions, code blocks, original raw text.
              The reference layer.
            </li>
            <li>
              <strong>Quiz Me</strong> — recall. A question is generated
              from the lesson; you answer; the grader scores you 0–100.
            </li>
            <li>
              <strong>my-AI-stro Chat</strong> — query. Natural-language
              Q&A grounded strictly in retrieved SOT entries, served by
              the dedicated advisor pipeline described above. The
              advisor refuses to invent material you haven't actually
              learned.
            </li>
            <li>
              <strong>Notebook</strong> — save. When the advisor
              produces a study guide you want to keep, save it to your
              Notebook. The saved note is a snapshot — same markdown,
              same syntax-highlighted code, same structure — viewable
              without re-running the 3-4 minute pipeline. Each saved
              section keeps a clickable reference back to the source
              SOT lesson it was assembled from, so the Notebook is a
              navigation hub between derived content and source. Notes
              are user-curated artifacts: explicitly not part of the
              SOT (the SOT is "what I learned"; the Notebook is "what
              I asked the advisor to assemble from what I learned").
            </li>
            <li>
              <strong>Classroom</strong> — be taught. The Teacher Aide
              builds a structured lesson plan; the Teacher plays it back
              beat-by-beat on a chalkboard with intro, exposition,
              examples, comprehension checks, and recap. You answer the
              checks; the grader scores them; the teacher gives
              personalized corrections.
            </li>
          </ul>
          <p>
            And one off-leash mode: <strong>General Chat</strong> — same
            local model layer, no SOT grounding. For when you want to ask
            the model anything without being constrained by your notes.
          </p>
        </Section>

        <Section title="Where the data lives">
          <p>
            my-AI-stro lives entirely on your machine. The SOT is{" "}
            <Code>backend/memory_store.json</Code>. The audit archive is{" "}
            <Code>backend/archived_store.json</Code>. Saved Notebook
            entries are one JSON each under{" "}
            <Code>backend/notebook/</Code>. The Obsidian vault mirror is
            at <Code>~/Documents/myAIstro-vault/</Code>. The LLMs run
            via Ollama on your Mac's GPU — llama3, llama3.1, llama3.2,
            mistral, all local.
          </p>
          <p>
            Nothing about any lesson you ingest leaves your computer. There
            are no telemetry pings, no analytics, no model APIs called
            outside <Code>localhost</Code>. The trade-off, named honestly:
            local models have a quality ceiling that hosted GPT-4-class
            models don't. For a personal study tool — where privacy plus
            zero usage caps plus no vendor lock-in matter — that ceiling
            is acceptable.
          </p>
        </Section>

        <Section title="Sharing with others">
          <p>
            If you want to show my-AI-stro to a friend, you can. A
            Tailscale Funnel pointed at the dev server gives you a stable
            public HTTPS URL with no domain to purchase.
          </p>
          <p>
            The owner — you — controls writes via an environment-variable
            password (<Code>MYAISTRO_WRITE_PASSWORD</Code>). Set it, then
            unlock once via the chip in your browser's localStorage. Every
            visitor who lands on the tunnel URL can:
          </p>
          <ul style={listStyle}>
            <li>Read the Graph, List, and Archives</li>
            <li>Chat with the SOT-grounded advisor</li>
            <li>Chat with the untethered general model</li>
            <li>Take guest Classroom sessions</li>
          </ul>
          <p>Visitors can't:</p>
          <ul style={listStyle}>
            <li>Ingest new lessons</li>
            <li>Re-summarize existing ones</li>
            <li>Sync to the Obsidian vault</li>
            <li>
              Have their Classroom sessions persist (guest mode is ephemeral
              on purpose)
            </li>
          </ul>
          <p>
            Your records stay clean. Guest Classroom sessions never touch
            the audit history or affect future spaced-repetition signal.
          </p>
        </Section>

        <Section title="What's intentionally not here">
          <p>
            Each of these was a choice, not an omission. They're the reason
            my-AI-stro is what it is:
          </p>
          <ul style={listStyle}>
            <li>
              <strong>No user accounts.</strong> Single-tenant by design.
            </li>
            <li>
              <strong>No telemetry calling out.</strong> Only the local
              visitor counter, in your own data file.
            </li>
            <li>
              <strong>No external LLM APIs.</strong> Ollama on localhost,
              period.
            </li>
            <li>
              <strong>No subscription, no usage caps, no surprise bills.
              </strong> Once running, it costs laptop electricity.
            </li>
            <li>
              <strong>No social features.</strong> Not a platform. A
              personal system that one person can share read-mode access to
              via a tunnel.
            </li>
          </ul>
        </Section>

        <Section title="Where it could go">
          <p>The natural next steps the architecture is preparing for:</p>
          <ul style={listStyle}>
            <li>
              <strong>Spaced-repetition surfacing.</strong> The audit loop
              already produces a deterministic richness score per version.
              The Classroom session records already capture which CHECK
              questions a student got wrong. Combine those signals and the
              system can start scheduling specific lessons for re-study at
              the right intervals.
            </li>
            <li>
              <strong>Cross-lesson synthesis in Classroom.</strong> The
              Teacher Aide currently builds plans from one SOT entry.
              Letting it pull from multiple related entries unlocks real
              curriculum-style teaching.
            </li>
            <li>
              <strong>Improv-mode Classroom.</strong> V2 of the Teacher
              could generate beat content at runtime, handle raise-hand
              questions, re-explain on demand. The plan already supports
              this; only the runtime gap remains.
            </li>
          </ul>
          <p>
            None of these are committed. They're the natural extensions the
            architecture has been quietly preparing for.
          </p>
        </Section>

        <Footer />
      </div>
    </div>
  );
}

// ============================================================
// HERO
// ============================================================
function Hero() {
  return (
    <div style={{ marginBottom: 36 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "var(--accent)",
          marginBottom: 12,
        }}
      >
        About my-AI-stro
      </div>
      <h1
        style={{
          fontSize: 32,
          fontWeight: 700,
          lineHeight: 1.2,
          margin: "0 0 18px 0",
          letterSpacing: "-0.01em",
          color: "var(--text)",
        }}
      >
        A personal knowledge graph that audits itself.
      </h1>
      <p
        style={{
          fontSize: 16,
          lineHeight: 1.65,
          color: "var(--text)",
          opacity: 0.92,
          margin: "0 0 14px 0",
        }}
      >
        my-AI-stro takes the lessons you've already learned, structures
        them into a queryable Source of Truth, and gives you ways to
        navigate, query, test yourself on, and even be taught from your
        own notes. Everything — including the LLMs doing the work — runs
        locally on your machine.
      </p>
      <p
        style={{
          fontSize: 16,
          lineHeight: 1.65,
          color: "var(--text-dim)",
          margin: 0,
        }}
      >
        It's not a notes app. It's not a chatbot wrapping ChatGPT. It's a
        single coherent loop: you bring the raw input, the system organizes
        it into structured knowledge, gives you ways to test and query
        that knowledge, and quietly improves the structure while you're
        not looking.
      </p>
    </div>
  );
}

// ============================================================
// SECTION
// ============================================================
function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--accent)",
          margin: "0 0 14px 0",
          paddingBottom: 8,
          borderBottom: "1px solid rgba(57,255,20,0.15)",
        }}
      >
        {title}
      </h2>
      <div style={{ color: "var(--text)" }}>{children}</div>
    </section>
  );
}

// ============================================================
// PIPELINE DIAGRAM
// ============================================================
function PipelineDiagram({ stages }) {
  return (
    <div
      style={{
        margin: "20px 0 24px 0",
        padding: "18px 14px",
        background: "rgba(57,255,20,0.04)",
        border: "1px solid rgba(57,255,20,0.16)",
        borderRadius: 10,
        overflowX: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minWidth: 580,
        }}
      >
        {stages.map((stage, i) => (
          <div
            key={stage}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: 1,
            }}
          >
            <div
              style={{
                flex: 1,
                padding: "8px 10px",
                background: "rgba(0,0,0,0.4)",
                border: "1px solid var(--accent-soft)",
                borderRadius: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--accent)",
                textAlign: "center",
                whiteSpace: "nowrap",
              }}
            >
              {stage}
            </div>
            {i < stages.length - 1 && (
              <span
                style={{
                  color: "var(--accent-soft)",
                  fontSize: 16,
                  flexShrink: 0,
                }}
              >
                →
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// AGENT TABLE
// ============================================================
const AGENTS = [
  ["Summarization",   "Extract structure from raw lesson text",        "llama3:8b"],
  ["Validation",      "Gate writes against malformed model output",    "— rule-based"],
  ["Audit",           "Background self-improvement loop",              "— orchestrator"],
  ["Judge",           "Score summary richness for the archive cycle",  "— deterministic"],
  ["Advisor",         "SOT-grounded chat (per-section pipeline)",      "llama3.1:8b"],
  ["Quiz Generator",  "Phrase recall questions from a lesson",         "llama3.2:latest"],
  ["Quiz Grader",     "Score student answers (separate from gen)",     "mistral:latest"],
  ["General Chat",    "Untethered conversation, no SOT context",       "llama3.2:latest"],
  ["Teacher Aide",    "Generate Classroom lesson plans",               "llama3.2:latest"],
  ["Teacher",         "Runtime corrections in Classroom",              "llama3.2:latest"],
  ["Memory Writer",   "Atomic SOT/archive persistence",                "— file I/O"],
];

function AgentTable() {
  return (
    <div
      style={{
        margin: "18px 0 22px 0",
        background: "rgba(0,0,0,0.3)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "180px 1fr 160px",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          color: "var(--text-mute)",
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          background: "rgba(57,255,20,0.04)",
        }}
      >
        <span>Agent</span>
        <span>Role</span>
        <span>Model</span>
      </div>
      {AGENTS.map(([name, role, model]) => (
        <div
          key={name}
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr 160px",
            padding: "10px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--text)", fontWeight: 500 }}>{name}</span>
          <span style={{ color: "var(--text-dim)" }}>{role}</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: model.startsWith("—") ? "var(--text-mute)" : "var(--accent)",
            }}
          >
            {model}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// FOOTER
// ============================================================
function Footer() {
  return (
    <div
      style={{
        marginTop: 48,
        paddingTop: 24,
        borderTop: "1px solid var(--border)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "var(--text-mute)",
        textAlign: "center",
      }}
    >
      Built locally. Lives locally. Yours.
    </div>
  );
}

// ============================================================
// PRIMITIVES
// ============================================================
function Code({ children }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.92em",
        color: "var(--accent)",
        background: "rgba(57,255,20,0.08)",
        padding: "1px 6px",
        borderRadius: 3,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// Multi-line code block with preserved indentation — used for the
// Judge's scoring formula. Same green-on-near-black palette as the
// inline <Code/> chip, but sized for a small block of arithmetic.
function FormulaBlock({ children }) {
  return (
    <pre
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        lineHeight: 1.55,
        color: "var(--accent)",
        background: "rgba(57,255,20,0.06)",
        border: "1px solid rgba(57,255,20,0.18)",
        borderRadius: 6,
        padding: "12px 16px",
        margin: "10px 0 14px 0",
        overflowX: "auto",
        whiteSpace: "pre",
      }}
    >
      {children}
    </pre>
  );
}

const listStyle = {
  margin: "12px 0 14px 0",
  paddingLeft: 20,
  color: "var(--text)",
};
