import { useMemo } from 'react'
import { marked } from 'marked'

interface Props {
  source: string
  className?: string
}

marked.setOptions({ gfm: true, breaks: true })

export function MarkdownBlock({ source, className }: Props) {
  const html = useMemo(() => marked.parse(source) as string, [source])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
