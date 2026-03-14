import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import JobSearchAgent from '../job-search-agent.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <JobSearchAgent />
  </StrictMode>
)
