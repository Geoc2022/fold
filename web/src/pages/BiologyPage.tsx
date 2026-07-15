import { BiologyRoom } from '../components/BiologyRoom'
import { useForceTheme } from '../useForceTheme'

export function BiologyPage() {
  useForceTheme('light')
  return <BiologyRoom showLabels={false} includeSelfNode={false} />
}
