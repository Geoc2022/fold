import { useEffect, useState } from 'react'

const svgCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

function loadSvg(slug: string): Promise<string> {
  const cached = svgCache.get(slug)
  if (cached) return Promise.resolve(cached)
  const pending = inflight.get(slug)
  if (pending) return pending
  const promise = fetch(`/pictograms/${slug}.svg`)
    .then((r) => r.text())
    .then((text) => {
      svgCache.set(slug, text)
      inflight.delete(slug)
      return text
    })
  inflight.set(slug, promise)
  return promise
}

interface Props {
  slug: string
  className?: string
}

/** Inlines a downloaded pictogram SVG (see pictogramCatalog.ts) so it can be
 * tinted with `color: currentColor` -- the files ship with no explicit fill
 * (SVG default black), and the actual color is whatever the parent sets. */
export function PictogramIcon({ slug, className }: Props) {
  const [svg, setSvg] = useState<string | null>(svgCache.get(slug) ?? null)

  useEffect(() => {
    let cancelled = false
    setSvg(svgCache.get(slug) ?? null)
    loadSvg(slug).then((text) => {
      if (!cancelled) setSvg(text)
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  return <span className={`${className ?? ''} pictogram-icon`} dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
}
