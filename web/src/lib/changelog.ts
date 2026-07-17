type Frontmatter = Record<string, string>

export type Release = {
  version: string
  name: string
  date: string
  body: string
}

export function parseMarkdown(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return { frontmatter: {}, body: raw.trim() }

  const frontmatter: Frontmatter = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  return { frontmatter, body: raw.slice(match[0].length).trim() }
}

export function cmpVersion(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const modules = import.meta.glob<string>('../content/changelog/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export const releases: Release[] = Object.values(modules)
  .map((raw) => {
    const { frontmatter, body } = parseMarkdown(raw)
    return {
      version: frontmatter.version ?? '0.0.0',
      name: frontmatter.name ?? 'Unnamed release',
      date: frontmatter.date ?? '',
      body,
    }
  })
  .sort((a, b) => cmpVersion(b.version, a.version))

export const latestRelease = releases[0]
