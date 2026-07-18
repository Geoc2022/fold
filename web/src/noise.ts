function hash2d(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return n - Math.floor(n)
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

export function valueNoise2d(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1
  const y1 = y0 + 1

  const sx = smooth(x - x0)
  const sy = smooth(y - y0)

  const n00 = hash2d(x0, y0)
  const n10 = hash2d(x1, y0)
  const n01 = hash2d(x0, y1)
  const n11 = hash2d(x1, y1)

  const ix0 = n00 + (n10 - n00) * sx
  const ix1 = n01 + (n11 - n01) * sx
  return ix0 + (ix1 - ix0) * sy
}

export function fractalNoise2d(x: number, y: number, octaves: number): number {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise2d(x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  if (norm <= 0) return 0
  return sum / norm
}
