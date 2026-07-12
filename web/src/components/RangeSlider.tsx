import { useId } from 'react'

interface Props {
  /** Lowest selectable value, e.g. 2. */
  floor: number
  /** Highest discrete tick before the "+" bucket, e.g. 15. */
  ceilingPlus: number
  valueMin: number
  /** null means unlimited ("15+"). */
  valueMax: number | null
  onChange: (min: number, max: number | null) => void
}

/** Dual-knob range slider with integer ticks floor..ceilingPlus, then a
 * final "+"/unlimited bucket. Paired with number inputs for exact entry. */
export function RangeSlider({ floor, ceilingPlus, valueMin, valueMax, onChange }: Props) {
  const id = useId()
  const plusPos = ceilingPlus + 1
  // Anything at or beyond the last tick displays pinned at the "+" position,
  // even if the underlying value (typed via the number input) is larger.
  const maxPos = valueMax == null ? plusPos : Math.min(plusPos, Math.max(valueMax, floor))
  const minPos = Math.min(Math.max(valueMin, floor), maxPos)

  const pct = (pos: number) => ((pos - floor) / (plusPos - floor)) * 100

  function setMinPos(pos: number) {
    onChange(Math.min(pos, maxPos), valueMax)
  }
  function setMaxPos(pos: number) {
    const clamped = Math.max(pos, minPos)
    const nextMin = Math.min(valueMin, clamped)
    onChange(nextMin, clamped >= plusPos ? null : clamped)
  }

  const ticks: number[] = []
  for (let t = floor; t <= plusPos; t += 1) ticks.push(t)

  return (
    <div className="range-slider">
      <div className="range-track">
        <div className="range-fill" style={{ left: `${pct(minPos)}%`, right: `${100 - pct(maxPos)}%` }} />
        <div className="range-ticks" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="range-tick" style={{ left: `${pct(t)}%` }} />
          ))}
        </div>
        <input
          type="range"
          aria-label="Minimum people"
          min={floor}
          max={plusPos}
          step={1}
          value={minPos}
          onChange={(e) => setMinPos(Number(e.target.value))}
        />
        <input
          type="range"
          aria-label="Maximum people"
          min={floor}
          max={plusPos}
          step={1}
          value={maxPos}
          onChange={(e) => setMaxPos(Number(e.target.value))}
        />
      </div>
      <div className="range-labels">
        <span>{floor}</span>
        <span>{ceilingPlus}+</span>
      </div>
      <div className="range-numbers">
        <label htmlFor={`${id}-min`}>
          Min
          <input
            id={`${id}-min`}
            type="number"
            min={1}
            value={valueMin}
            onChange={(e) => {
              const v = Math.max(1, Number(e.target.value) || 1)
              onChange(v, valueMax != null ? Math.max(v, valueMax) : null)
            }}
          />
        </label>
        <label htmlFor={`${id}-max`}>
          Max <span className="opt">(blank = ∞)</span>
          <input
            id={`${id}-max`}
            type="number"
            min={1}
            placeholder="∞"
            value={valueMax ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              if (raw.trim() === '') {
                onChange(valueMin, null)
                return
              }
              const v = Math.max(1, Number(raw) || 1)
              onChange(Math.min(valueMin, v), v)
            }}
          />
        </label>
      </div>
    </div>
  )
}
