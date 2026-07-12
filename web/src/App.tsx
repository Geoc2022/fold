import './App.css'
import { Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { ActivityRoom } from './pages/ActivityRoom'
import { PhysicsPage } from './pages/PhysicsPage'
import { ChemistryPage } from './pages/ChemistryPage'
import { BiologyPage } from './pages/BiologyPage'

export default function App() {
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
            <h1>fold</h1>
            <p className="pending">That page does not exist.</p>
          </main>
        }
      />
    </Routes>
  )
}
