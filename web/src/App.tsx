import './App.css'
import { Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { ActivityRoom } from './pages/ActivityRoom'
import { PhysicsPage } from './pages/PhysicsPage'
import { ChemistryPage } from './pages/ChemistryPage'
import { BiologyPage } from './pages/BiologyPage'

export default function App() {
  // add the picture frame 404 page
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/physics" element={<PhysicsPage />} />
      <Route path="/chemistry" element={<ChemistryPage />} />
      <Route path="/biology" element={<BiologyPage />} />
      <Route path="/:code" element={<ActivityRoom />} />
      <Route
        path="*"
        element={
          <main className="shell">
            <h1>Fold</h1>
            <p className="pending">That page does not exist.</p>
          </main>
        }
      />
    </Routes>
  )
}
