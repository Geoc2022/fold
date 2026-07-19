export const REPO_URL = 'https://github.com/Geoc2022/fold'

export function repoBlob(path: string): string {
  const normalized = path.replace(/^\/+/, '')
  return `${REPO_URL}/blob/main/${normalized}`
}

export const LANGUAGE_DOCS_URL = repoBlob('docs/language.md')
