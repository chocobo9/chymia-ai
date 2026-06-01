import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './choco.css'
import './choco-overlays.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
