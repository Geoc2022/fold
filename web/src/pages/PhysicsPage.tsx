import { BiologyRoom } from '../components/BiologyRoom'
import { useForceTheme } from '../useForceTheme'

// Physics: the bare node-motion sandbox. Manual nodes only (no auto-sim) and a
// single fused cluster (no grouping), so the focus is the ETA ring + tug-of-war
// state changes shared by every room.
export function PhysicsPage() {
  useForceTheme('light')
  return <BiologyRoom autoSimulate={false} grouping={false} controls={{}} />
}
