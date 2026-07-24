import { useEffect, useRef } from 'react'
import { sound } from '../../lib/sound'

export type Sharpness = {
  score: number
  grade: 0 | 1 | 2 | 3
  label: string
  tip: string
}

const GRADES: { label: string; tip: string }[] = [
  { label: 'Dull', tip: 'Mix cases, digits, and symbols to sharpen.' },
  { label: 'Keen', tip: 'Getting an edge — more variety sharpens further.' },
  { label: 'Sharp', tip: 'Clean edge. This’ll do nicely.' },
  { label: 'Razor', tip: 'Atomic edge. Cherish it.' },
]

/** Password strength, phrased as blade sharpness: dull → keen → sharp → razor. */
export function scorePassword(pw: string): Sharpness {
  if (!pw) return { score: 0, grade: 0, label: GRADES[0].label, tip: '8+ characters to leave the whetstone.' }
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  const grade = (score <= 1 ? 0 : score === 2 ? 1 : score <= 4 ? 2 : 3) as 0 | 1 | 2 | 3
  return { score, grade, label: GRADES[grade].label, tip: GRADES[grade].tip }
}

/**
 * Four-segment meter with a grade label. The label carries the meaning
 * (color is reinforcement only). A quiet whetstone tick plays whenever the
 * grade improves — never on the first character or on downgrade.
 */
export function SharpnessMeter({ password }: { password: string }) {
  const { grade, label, tip } = scorePassword(password)
  const prevGrade = useRef<number | null>(null)

  useEffect(() => {
    if (!password) {
      prevGrade.current = null
      return
    }
    if (prevGrade.current !== null && grade > prevGrade.current) {
      sound.previewTick()
    }
    prevGrade.current = grade
  }, [grade, password])

  if (!password) return null

  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="auth-meter flex items-center gap-1.5" data-grade={grade} aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="auth-meter-seg" data-on={i <= grade ? 'true' : undefined} />
        ))}
      </div>
      <p className="text-2xs text-[var(--color-text-faint)]">
        <span key={label} className="auth-meter-label font-semibold text-[var(--color-text-dim)]">
          {label}
        </span>
        <span className="mx-1.5 opacity-50" aria-hidden>
          ·
        </span>
        {tip}
      </p>
    </div>
  )
}
