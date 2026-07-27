// The project's public legal documents — the only outbound links the app makes
// on its own, and it makes them lazily: nothing is fetched, they are hrefs.
//
// Why they point outwards instead of shipping in the bundle: these policies
// describe services the *project operator* runs (the marketing site and the one
// hosted instance). A self-hosted deployment is governed by whoever runs it, so
// bundling the text would be worse than linking it — a copy inside someone
// else's build would read as if it applied to their server, and it would rot the
// moment the real page changed.
//
// That is also why every surface that links here labels them as the **sharp
// project's** documents rather than "our privacy policy". Don't drop that word.
//
// Contract note: these URLs are load-bearing for `landing/src/pages/{privacy,terms}.astro`.
// Change a route there and change it here.

const LANDING = 'https://sharp.davideghiotto.it'

export const PRIVACY_URL = `${LANDING}/privacy`
export const TERMS_URL = `${LANDING}/terms`
