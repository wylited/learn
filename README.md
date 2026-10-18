# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This is a personal system I built for myself, shared as-is. Built as a pi configuration: the teaching philosophy encoded in a skill, a few small extensions, and agent definitions.

## What's in it

- `skills/teach/` — the philosophy and the process
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `extensions/ask-user-question/` — the agent asks you questions through a UI popup
- `extensions/quiz/` — graded questions with instant feedback (✓/✗, correct answer, explanation)
- `extensions/md-log/` — link a markdown file to the session
- `extensions/visual-tools/` — tools for visualization subagents
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to

## The `learn` app — durable standalone CLI

`app/` is a self-contained pi-durable application (no `.pi` needed): the same
teaching system with crash-resumable sessions, parallel subagents
(researcher + typst-maker + mermaid-maker), a typst→PNG/SVG pipeline, and the
confidence quiz. It shares only the repo's `skills/` and `agents/` content.

```bash
cd app && npm install && npm run warm && npm link   # then ensure the npm global bin (e.g. ~/.npm-global/bin) is on PATH
learn "half-adders"          # start a lesson in the current directory
learn --continue             # resume the newest session here after a crash or exit
learn --print "question"     # one headless turn, no TUI
learn --model anthropic/claude-sonnet-5 "topic"
learn -d                     # -d/--debug starts with the background task panel open (/tasks toggles it)
```

Requirements: node ≥ 23 (type stripping; 24 tested), typst on PATH or at
`~/.cargo/bin` (packages pre-cached by `npm run warm`), and one LLM credential
— checked in order: env (`ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `COMMAND_CODE_API_KEY`), `~/.pi/agent/auth.json`,
omp's `~/.omp/agent/agent.db`. Providers: `zai`, `anthropic`, `openrouter`, `openai`,
`github-copilot`, `opencode`, `deepseek`, and `commandcode` (Command Code Provider API;
catalog fetched live, `user_…` subscription keys). Default model
`commandcode/deepseek/deepseek-v4.1-flash`; override with `LEARN_MODEL` or `--model`.

Web search reuses omp's Perplexity session (`~/.omp/agent/agent.db`, email-OTP
login — or set `LEARN_PERPLEXITY_TOKEN`); without it searches run anonymous and
may hit a quota wall. Quiz flow: one dialog — question, choices (choice mode)
and a reasoning editor all visible together; picking an answer swaps the list
for a confidence strip (1 Sure / 2 Pretty sure / 3 Guessed) while the reasoning
stays editable; `mode: "free"` skips choices — the typed answer is graded by
the teacher (blank = "I don't know"). The teacher adapts to the grade×confidence
pair and mines the reasoning. Subagents can run blocking or
`await: "background"` (result arrives as a follow-up message while the lesson
continues); published diagrams land in `viz/`.

## Install

This repo **is** a `.pi` directory. From your learning project's root:

```bash
git clone https://github.com/amosblomqvist/learn .pi
```

Then open pi in that directory. (Or copy the pieces you want into your existing project config.)

## Requirements

- [pi](https://github.com/earendil-works/pi)
- A subagent implementation, so the system can spawn the researcher and the visual makers. Recommended: [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux only). With it, everything works out of the box. Any other implementation works too, but expect to adapt the agent definitions, e.g. `agents/researcher.md` lists `safe_bash` in its tools, which is specific to that extension.
- `ask-user-question` — use the copy bundled here. If your setup already has an `ask-user-question` extension, use **this** one in its place. Popups from different extensions serialize through a shared UI lock, which only works when it's the same implementation.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.
