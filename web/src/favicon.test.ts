import { describe, expect, it } from 'vitest'
import { presenceFaviconSvg } from './favicon'

describe('presenceFaviconSvg', () => {
  it('draws user node last so it stays above others', () => {
    const svg = presenceFaviconSvg({ user: 'committed', other: 'interested', center: 'other' })
    const interestedPos = svg.indexOf('fill="#00A651"')
    const committedPos = svg.indexOf('fill="#FA841E"')
    expect(interestedPos).toBeGreaterThan(-1)
    expect(committedPos).toBeGreaterThan(interestedPos)
  })

  it('centers arrived user for single-node state', () => {
    const svg = presenceFaviconSvg({ user: 'arrived', other: null, center: 'user' })
    expect(svg).toContain('cx="125" cy="125"')
    expect(svg).toContain('fill="#F0282D"')
  })
})
