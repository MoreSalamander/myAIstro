# Frontend

The browser-side of my-AI-stro. React on Vite. Vanilla CSS variables + Tailwind v4 for styling. No state library — local component state and a small amount of `localStorage` for persistent settings.

For the project overview, see the [root README](../README.md). For the engineering rationale behind specific design choices, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Dev server

```bash
npm install
npm run dev
```

Vite serves the app on `http://localhost:5173`. The `/api/*` path is proxied to the FastAPI backend on `:8000` (see `vite.config.js`), so the React code uses relative URLs throughout — same code works locally, through a Cloudflare Tunnel, or through a Tailscale Funnel without changes.

## File organization

```
src/
├── App.jsx                 Top-level routing between panels, ingest modal,
│                           write-password unlock, hash-based deep links
├── main.jsx                Vite entry
├── index.css               Color tokens (CSS variables), Tailwind base
├── App.css                 Component-level utilities not worth Tailwinding
├── components/
│   ├── GraphPanel.jsx      Force-directed graph view (the home screen)
│   ├── SotBrowser.jsx      List view of SOT entries
│   ├── ChatPanel.jsx       Hub chat (advisor + general)
│   ├── ArchivesPanel.jsx   Audit-archived entries, with manual audit-step trigger
│   ├── IngestPanel.jsx     The paste-a-lesson modal
│   ├── DataFlowCanvas.jsx  Live NDJSON pipeline animation during ingest
│   ├── QuizPanel.jsx       Quiz Me flow (generator + grader)
│   ├── LessonDrawer.jsx    Reusable expanded-lesson viewer
│   ├── AboutPanel.jsx      In-app product explainer
│   └── classroom/
│       ├── ClassroomPanel.jsx     Beat-by-beat playback shell
│       ├── BeatRenderer.jsx       Per-beat-type rendering
│       ├── LessonPicker.jsx       Pick a lesson to study
│       ├── LessonPlanSidebar.jsx  Plan progress sidebar
│       └── classroomTypes.js      Plan/beat type constants
└── lib/
    └── writeAuth.js        Tiny client for the X-Write-Password header
```

## Build

```bash
npm run build      # production bundle into ./dist
npm run preview    # serve the production bundle locally
```

In practice the project is run from the dev server. Production-style builds aren't part of the personal-tool workflow.

## Allowed hosts

`vite.config.js` allow-lists the dev server for:

- `localhost` and `127.0.0.1`
- `.trycloudflare.com` (Cloudflare quick tunnels)
- `.cfargotunnel.com` (named Cloudflare tunnels)
- `.ts.net` (Tailscale, including Funnel hostnames)

Vite rejects unknown `Host` headers by default as a DNS-rebinding defense; these are the patterns the project uses for tunnel-based sharing.

## Style

See [docs/STYLE.md](../docs/STYLE.md) in the repo root for the commenting voice this codebase follows.
