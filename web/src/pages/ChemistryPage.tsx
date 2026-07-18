import { BiologyRoom } from '../components/BiologyRoom'
import { useForceTheme } from '../useForceTheme'

// Chemistry: the physics sandbox plus grouping. Manual nodes fuse into single
// or parallel clusters as they arrive; everything else (mechanics, rendering,
// ETA ring) is the shared room engine.
export function ChemistryPage() {
  useForceTheme('light')
  return <BiologyRoom autoSimulate={false} controls={{ grouping: true }} />
}
