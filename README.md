# Nudge

A single-file to-do app that nudges you about the things you forgot to schedule.
`index.html` is the whole client - no build step, open it directly or serve it.

## AI task analysis

Optional, off by default (Settings → AI task analysis). When on, typing a task
calls `POST /api/analyze`, which asks Claude for a due date, time, priority and
category. Nothing is written to the task until you press Apply.

The app degrades quietly: if the backend is missing, unreachable, or erroring,
the suggestion bar never appears and the offline keyword nudge on the date
button carries on as before. So `index.html` still works opened as a plain file.

### Deploying

    vercel link
    vercel env add ANTHROPIC_API_KEY    # server-side only, never shipped to the browser
    vercel deploy --prod

### Cost

One Claude call per distinct task text, debounced 900ms while typing, skipped
under 12 characters, and cached per-text for the session. Runs on `claude-opus-5`
at `effort: "low"` - extraction this small doesn't need more.

## Local development

    python3 -m http.server 8899     # client only; the AI bar stays hidden
    vercel dev                      # client + /api/analyze, needs ANTHROPIC_API_KEY
