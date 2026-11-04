# Luma Bot

Automatically register to hundreds of [Luma](https://luma.com) events from a calendar
or from a list of event links, powered by AI. It drives a real Chrome browser through
each event page, fills in the registration form (using your profile), answers host
questions with an LLM, picks the right free ticket, and handles the Cloudflare
Turnstile — like a human would.

Two accounts, one investor profile, one regular — or as many as you like.

---

## Quickest start: let Claude do it

This repo is built to be set up and run with [Claude Code](https://claude.com/claude-code).
Clone it, open it in Claude Code, and paste:

> Read the README, then set up and run the Luma bot for me. Ask me for my Luma login
> and the calendar or event links I want to register to.

Claude will walk you through the three things it needs (below) and start the run.

---

## What you need

1. **Node.js** — https://nodejs.org (LTS). Then `npm i` in this folder.
2. **Google Chrome** — https://www.google.com/chrome/
3. **A Claude token** — run `claude setup-token` and paste it as `CLAUDE_CODE_OAUTH_TOKEN`
   in `config.txt` (used to answer host questions and choose tickets).
4. **Your Luma session cookie** — see [Accounts](#accounts) below.

Copy `config_template.txt` to `config.txt` and fill it in. `config.txt` is gitignored
and **never committed** — it holds your cookies and token.

---

## Your profile

The bot answers registration questions from a profile file. **Never put real personal
data in a tracked file.**

- `profile.txt` and `profiles/example.txt` are **templates** (placeholders only).
- Your real per-account profiles go in `profiles/<id>.txt` — these are **gitignored**
  and stay on your machine.

Create one file per account, e.g. `profiles/one.txt`:

```
Company: ...
Designation: ...
Email: ...
Name : ...
Location: ...
Ticket Preference : Investor ticket when the event has one; otherwise general admission.
```

Use `n/a` for anything you don't have. Add any fields that events tend to ask for.

---

## Accounts

One `COOKIES_ACCOUNT_<ID>` entry per account (in `config.txt`, or as an env var on a
server), each paired with a `profiles/<id>.txt` file:

- `COOKIES_ACCOUNT_ONE` → `profiles/one.txt`
- `COOKIES_ACCOUNT_TWO` → `profiles/two.txt`

**Getting the cookie:** log into luma.com in your browser, open DevTools →
Application → Cookies → copy the value of `luma.auth-session-key`. Pasting the whole
`Cookie` header also works (everything except `luma.auth-session-key` and `luma.did`
is ignored). The session lasts until you log out of that browser session.

---

## Running

```
npm run server
```

Registers every account to everything in `EVENT_CALENDAR_URL`, headless, no manual
login. Events you already applied to (registered / pending / waitlist) are skipped.

Useful toggles (env vars override `config.txt`):

| Variable | What it does |
| --- | --- |
| `EVENT_CALENDAR_URL` | Calendar(s) **and/or** direct event link(s), comma-separated. See below. |
| `ONLY_ACCOUNTS` | Limit the run, e.g. `ONLY_ACCOUNTS=one` or `one,two`. |
| `HEADLESS` | `false` shows the browser window (local debugging). Default headless. |
| `MAX_EVENTS` | Stop after N events (test batches). |
| `DRY_RUN` | `true` lists events without submitting. |
| `MANUAL_SUBMIT` | `true` fills each form and lets you click Submit yourself. |
| `TIMEZONE` | Sent with registrations, e.g. `Europe/Paris`. |

### Calendars and direct event links

`EVENT_CALENDAR_URL` accepts both, mixed freely:

```
EVENT_CALENDAR_URL=https://luma.com/token2049,https://luma.com/px5f2j4k,https://luma.com/afr82s1n
```

- A **calendar** link (e.g. `luma.com/token2049`) — the bot scrolls it and registers
  to every event listed.
- A **direct event** link (e.g. `luma.com/px5f2j4k`) — the bot registers to just that
  event. It auto-detects which kind each link is.

Example — run both accounts against a list of event links:

```
EVENT_CALENDAR_URL="https://luma.com/a,https://luma.com/b,https://luma.com/c" npm run server
```

---

## Running on a server (Railway, every 24h)

The included `Dockerfile` runs the headless bot. Deploy to Railway and schedule it
daily. Set `EVENT_CALENDAR_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, and each
`COOKIES_ACCOUNT_<ID>` as service variables (not in the image).

```
railway init            # or: railway link
railway variables --set "EVENT_CALENDAR_URL=https://luma.com/xxxx" \
  --set "CLAUDE_CODE_OAUTH_TOKEN=..." \
  --set "COOKIES_ACCOUNT_ONE=..." --set "COOKIES_ACCOUNT_TWO=..." \
  --set "TIMEZONE=Europe/Paris"
railway up
```

The container exits when done; schedule it with a Railway cron.

---

## Extracting participants

`npm run extract-guests -- [calendar URLs...] [--period=future|past|all]` writes the
Luma profile links of each event's participants to `output/<calendar>_*.csv`.
Calendars default to `EVENT_CALENDAR_URL`, period to `all`. Every `COOKIES_ACCOUNT_<ID>`
is tried per event; Luma only returns a full guest list to an approved guest when the
host shows it, otherwise the publicly-featured guests are used.

---

## Safety / privacy

- `config.txt` (cookies, token) and `profiles/*.txt` (your real data) are **gitignored**.
- Only the placeholder templates (`profile.txt`, `profiles/example.txt`) are committed.
- Don't commit your cookies or personal profile. If you fork this, keep it that way.
