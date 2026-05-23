import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Single dev server: Vite serves the React app on :5173, and proxies any
// /api/* request to the FastAPI backend on :8000. Frontend code uses
// relative URLs ("/api/sot/graph"), which works:
//   - locally (proxy hops to localhost:8000)
//   - through a Cloudflare Tunnel pointing at :5173 (everything goes
//     through the same hostname; the proxy keeps /api/* on the same
//     origin, so no CORS, no second tunnel)
//
// Streaming endpoints (/api/ingest, /api/advisor/chat, /api/chat/general)
// need ws:true semantics? No — they're plain NDJSON over HTTP. The proxy
// passes them through as-is.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    // Allow Cloudflare quick-tunnel hostnames (and named tunnels) to load
    // the dev server. Vite blocks unknown Host headers by default as a
    // DNS-rebinding defense; harmless here since the tunnel itself is the
    // only way in, but Vite doesn't know that.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.trycloudflare.com',   // Cloudflare quick tunnels
      '.cfargotunnel.com',    // Cloudflare named tunnels
      '.ts.net',              // Tailscale Funnel
    ],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
