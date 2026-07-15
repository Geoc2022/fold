export const TUG_WIDTH = 70
export const TUG_WIDTH_HOLD_MS = 850
export const INTERESTED_GAP = 90

export interface TugModel {
  workNeeded: number
  commitMaxR: number
  commitOutTugR: number
  commitInTugR: number
  interestedMaxR: number
  interestedOutTugR: number
  interestedInTugR: number
}

export function createTugModel(worldR: number): TugModel {
  const commitMaxR = worldR
  const commitOutTugR = commitMaxR + TUG_WIDTH
  const commitInTugR = Math.max(0, commitMaxR - TUG_WIDTH)
  const interestedMaxR = commitOutTugR + INTERESTED_GAP
  const interestedOutTugR = interestedMaxR + TUG_WIDTH
  const interestedInTugR = Math.max(0, interestedMaxR - TUG_WIDTH)
  return {
    workNeeded: TUG_WIDTH * TUG_WIDTH_HOLD_MS,
    commitMaxR,
    commitOutTugR,
    commitInTugR,
    interestedMaxR,
    interestedOutTugR,
    interestedInTugR,
  }
}

export function tugPositionOutward(rawR: number, maxR: number, tugR: number) {
  if (rawR <= maxR) return rawR
  const width = tugR - maxR
  const extra = rawR - maxR
  return maxR + width * (1 - Math.exp(-extra / width))
}

export function tugPositionInward(rawR: number, minR: number, tugR: number) {
  if (rawR >= minR) return rawR
  const width = minR - tugR
  const extra = minR - rawR
  return minR - width * (1 - Math.exp(-extra / width))
}
