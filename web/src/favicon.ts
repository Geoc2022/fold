import type { PresenceBadgeModel } from './activityPresence'
import { nodeColor } from './nodeVisual'

const DEFAULT_FAVICON = '/favicon.svg'
const CENTER = { x: 125, y: 125 }
const OFFSET = { x: 145, y: 145 }

const faviconCache = new Map<string, string>()

export function setDefaultFavicon(): void {
  setFaviconHref(DEFAULT_FAVICON)
}

export function setPresenceFavicon(model: PresenceBadgeModel | null): void {
  if (!model) {
    setDefaultFavicon()
    return
  }
  const key = `${model.user}|${model.other ?? 'none'}|${model.center}`
  const cached = faviconCache.get(key)
  if (cached) {
    setFaviconHref(cached)
    return
  }
  const svg = presenceFaviconSvg(model)
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`
  faviconCache.set(key, href)
  setFaviconHref(href)
}

export function presenceFaviconSvg(model: PresenceBadgeModel): string {
  const userCenter = model.other == null
    ? (model.user === 'arrived' ? CENTER : OFFSET)
    : model.center === 'user' ? CENTER : OFFSET
  const otherCenter = model.other == null
    ? null
    : model.center === 'other' ? CENTER : OFFSET

  const circles: string[] = []
  if (otherCenter && model.other) {
    circles.push(circleSvg(otherCenter.x, otherCenter.y, nodeColor(model.other)))
  }
  circles.push(circleSvg(userCenter.x, userCenter.y, nodeColor(model.user)))

  return [
    '<svg width="250" height="250" viewBox="0 0 250 250" fill="none" xmlns="http://www.w3.org/2000/svg">',
    '<rect width="250" height="250" rx="40" fill="white"/>',
    ...circles,
    '</svg>',
  ].join('')
}

function circleSvg(x: number, y: number, fill: string): string {
  return `<circle cx="${x}" cy="${y}" r="67" fill="${fill}" stroke="white" stroke-width="12"/>`
}

function setFaviconHref(href: string): void {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
  if (links.length === 0) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = href.startsWith('data:image/svg+xml') ? 'image/svg+xml' : 'image/svg+xml'
    link.href = href
    document.head.appendChild(link)
    return
  }
  for (const link of links) {
    link.href = href
    if (link.type) link.type = 'image/svg+xml'
  }
}
