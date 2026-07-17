import faqRaw from '../content/faq.md?raw'
import { parseMarkdown } from './changelog'

export type HowTo = {
  title: string
  order: number
  body: string
}

const modules = import.meta.glob<string>('../content/howto/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export const faq = faqRaw.trim()

export const howTos: HowTo[] = Object.values(modules)
  .map((raw) => {
    const { frontmatter, body } = parseMarkdown(raw)
    return {
      title: frontmatter.title ?? 'Untitled',
      order: Number(frontmatter.order ?? 0),
      body,
    }
  })
  .sort((a, b) => a.order - b.order)
