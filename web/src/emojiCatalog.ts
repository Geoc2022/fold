// Curated activity-relevant emoji + search keywords, used to suggest icons
// as the user types an activity title. Not exhaustive (there are ~3,700
// emoji in Unicode) -- scoped to what an intern activity board actually
// needs: sports, games, food, work, arts, outdoors, social.

export interface EmojiEntry {
  emoji: string
  keywords: string[]
}

export const EMOJI_CATALOG: EmojiEntry[] = [
  // Sports
  { emoji: '🏸', keywords: ['badminton', 'racket', 'shuttlecock'] },
  { emoji: '🏀', keywords: ['basketball', 'hoops'] },
  { emoji: '⚽', keywords: ['soccer', 'football'] },
  { emoji: '🏈', keywords: ['football', 'american'] },
  { emoji: '⚾', keywords: ['baseball'] },
  { emoji: '🎾', keywords: ['tennis'] },
  { emoji: '🏐', keywords: ['volleyball'] },
  { emoji: '🏓', keywords: ['pingpong', 'ping pong', 'table tennis'] },
  { emoji: '🏒', keywords: ['hockey', 'icehockey'] },
  { emoji: '⛳', keywords: ['golf'] },
  { emoji: '🥊', keywords: ['boxing'] },
  { emoji: '🏊', keywords: ['swimming', 'swim', 'pool'] },
  { emoji: '🚴', keywords: ['cycling', 'biking', 'bike'] },
  { emoji: '🏃', keywords: ['running', 'run', 'jog', 'jogging'] },
  { emoji: '🧗', keywords: ['climbing', 'climb', 'bouldering'] },
  { emoji: '⛷️', keywords: ['skiing', 'ski'] },
  { emoji: '🏂', keywords: ['snowboarding', 'snowboard'] },
  { emoji: '🤸', keywords: ['gymnastics', 'cartwheel'] },
  { emoji: '🥋', keywords: ['martialarts', 'martial arts', 'karate', 'judo', 'taekwondo'] },
  { emoji: '🏹', keywords: ['archery'] },
  { emoji: '🎳', keywords: ['bowling'] },
  { emoji: '🛹', keywords: ['skateboarding', 'skateboard', 'skating'] },
  { emoji: '🏄', keywords: ['surfing', 'surf'] },
  { emoji: '🚣', keywords: ['rowing', 'kayak', 'kayaking'] },
  { emoji: '🏇', keywords: ['horse', 'horseback', 'riding'] },
  { emoji: '🤺', keywords: ['fencing'] },
  { emoji: '🥌', keywords: ['curling'] },
  { emoji: '🏋️', keywords: ['weightlifting', 'gym', 'workout', 'lifting'] },

  // Games
  { emoji: '🎲', keywords: ['boardgame', 'board game', 'dice', 'games'] },
  { emoji: '♟️', keywords: ['chess'] },
  { emoji: '🃏', keywords: ['cards', 'poker', 'cardgame'] },
  { emoji: '🀄', keywords: ['mahjong'] },
  { emoji: '🎯', keywords: ['darts'] },
  { emoji: '🕹️', keywords: ['videogames', 'video games', 'arcade'] },
  { emoji: '🎮', keywords: ['gaming', 'console', 'controller'] },
  { emoji: '🧩', keywords: ['puzzle', 'jigsaw'] },
  { emoji: '🎰', keywords: ['casino', 'slots'] },
  { emoji: '🧠', keywords: ['trivia', 'quiz', 'brain'] },

  // Food & drink
  { emoji: '☕', keywords: ['coffee', 'cafe'] },
  { emoji: '🍵', keywords: ['tea'] },
  { emoji: '🍺', keywords: ['beer', 'brewery'] },
  { emoji: '🍷', keywords: ['wine'] },
  { emoji: '🍕', keywords: ['pizza'] },
  { emoji: '🍔', keywords: ['burger', 'burgers'] },
  { emoji: '🍜', keywords: ['noodles', 'ramen', 'ramyun'] },
  { emoji: '🍣', keywords: ['sushi'] },
  { emoji: '🌮', keywords: ['taco', 'tacos'] },
  { emoji: '🍰', keywords: ['cake', 'dessert'] },
  { emoji: '🍦', keywords: ['icecream', 'ice cream'] },
  { emoji: '🥗', keywords: ['salad', 'healthy'] },
  { emoji: '🍳', keywords: ['breakfast', 'brunch'] },
  { emoji: '🍿', keywords: ['popcorn', 'movienight', 'movie night'] },
  { emoji: '🍻', keywords: ['cheers', 'happyhour', 'happy hour', 'drinks'] },
  { emoji: '🧋', keywords: ['boba', 'bubbletea', 'bubble tea'] },
  { emoji: '🍽️', keywords: ['dinner', 'lunch', 'meal', 'potluck'] },
  { emoji: '🎂', keywords: ['birthday', 'party'] },

  // Work / study
  { emoji: '💼', keywords: ['meeting', 'work', 'business'] },
  { emoji: '📊', keywords: ['presentation', 'standup', 'slides'] },
  { emoji: '💻', keywords: ['coding', 'hackathon', 'hack', 'programming'] },
  { emoji: '📚', keywords: ['bookclub', 'book club', 'reading', 'study', 'studygroup'] },
  { emoji: '✏️', keywords: ['writing'] },
  { emoji: '🎤', keywords: ['karaoke', 'mic', 'singing'] },
  { emoji: '🎬', keywords: ['movie', 'film', 'cinema'] },
  { emoji: '📷', keywords: ['photography', 'photo'] },

  // Music & arts
  { emoji: '🎵', keywords: ['music'] },
  { emoji: '🎸', keywords: ['guitar', 'band'] },
  { emoji: '🥁', keywords: ['drums'] },
  { emoji: '🎨', keywords: ['art', 'painting'] },
  { emoji: '🖌️', keywords: ['drawing', 'paint'] },
  { emoji: '🩰', keywords: ['dance', 'ballet'] },
  { emoji: '💃', keywords: ['dancing', 'dance'] },
  { emoji: '🎭', keywords: ['theater', 'theatre', 'drama'] },

  // Outdoors
  { emoji: '🏕️', keywords: ['camping', 'camp'] },
  { emoji: '🥾', keywords: ['hiking', 'hike', 'trail'] },
  { emoji: '🎣', keywords: ['fishing', 'fish'] },
  { emoji: '🏖️', keywords: ['beach'] },
  { emoji: '🌳', keywords: ['park', 'nature', 'outdoors'] },
  { emoji: '🚶', keywords: ['walking', 'walk', 'stroll'] },
  { emoji: '🛶', keywords: ['canoe', 'canoeing'] },
  { emoji: '🧘', keywords: ['yoga', 'meditation', 'mindfulness'] },
  { emoji: '🐶', keywords: ['dog', 'dogwalk', 'pet', 'pets'] },
  { emoji: '♻️', keywords: ['volunteer', 'cleanup', 'recycling'] },
]

/** Ranked emoji matching a free-text query (e.g. an in-progress activity
 * title). Falls back to `null` matches when the query is empty. */
export function searchEmoji(query: string, limit = 24): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  if (words.length === 0) {
    return EMOJI_CATALOG.slice(0, limit).map((e) => e.emoji)
  }

  const scored = EMOJI_CATALOG.map((entry) => {
    let score = 0
    for (const kw of entry.keywords) {
      for (const w of words) {
        if (kw === w) score += 3
        else if (kw.startsWith(w) || w.startsWith(kw)) score += 2
        else if (kw.includes(w) || w.includes(kw)) score += 1
      }
    }
    return { entry, score }
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  const matched = scored.slice(0, limit).map((s) => s.entry.emoji)
  if (matched.length >= limit) return matched

  // Pad with the default catalog order so the grid never looks sparse.
  const seen = new Set(matched)
  for (const entry of EMOJI_CATALOG) {
    if (matched.length >= limit) break
    if (!seen.has(entry.emoji)) {
      matched.push(entry.emoji)
      seen.add(entry.emoji)
    }
  }
  return matched
}
