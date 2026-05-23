/**
 * main.jsx — Vite entry. Mounts the React tree into <div id="root">.
 *
 * StrictMode is on intentionally; the App component's effects use a
 * ref guard so double-invocation in development doesn't inflate the
 * visit counter or fire duplicate write requests.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
