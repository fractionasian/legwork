# Show HN draft — Legwork

> Scaffold to rewrite in your own voice. The angle is **opinionated tool, transparently vibe-coded**.
> Lead with the person + the itch; let "I can't really code" land as honest aside, not the headline.
> Prepared 2026-06-06.

---

## Title (pick one — recommend #1)

1. `Show HN: Legwork – an opinionated, free running route planner (no account)`  ← recommended; "opinionated" is a known positive signal on HN and sets up the comment
2. `Show HN: Legwork – a free running route planner that snaps to real paths`
3. `Show HN: Legwork – a doctor's opinionated take on planning running routes`

HN style: en-dash, ≤80 chars, no hype words. Keep the vibe-coded/doctor story in the comment, not the title.

**URL:** https://legwork.day

---

## First comment (post this yourself, right after submitting)

Hi HN. I'm a doctor, not a developer. I run regularly, got fed up planning routes, and built the tool I wanted.

Up front, since I'd rather be transparent: I can't really code — I built Legwork by directing AI coding tools, learning as I went. I'm only posting it because it genuinely works and I use it every week.

It's deliberately opinionated. The belief behind it: **planning the route should be the good part** — most tools treat it as a chore on the way to the run.

- Click waypoints and the route snaps to real OSM footways/cycleways via a Dijkstra search weighted *away* from busy roads (footpath/cycleway 1.0×, residential 1.1×, tertiary 1.3×, secondary 1.6×, primary 2.0×, trunk 2.5×), so it prefers quiet paths over a shorter highway.
- Paths are coloured by gradient (green→red) so you see the hills before you run them.
- Loop / out-and-back / one-way, GPX export, shareable links.
- PWA with offline support and a few pre-cached cities — works without signal mid-run.
- No account, no ads.

What it deliberately does **not** do: no social feed, leaderboards, segments, saved-route folders, or training analytics. Strava, Garmin Connect and AllTrails do those well. Legwork does one thing — hand you a clean route — and gets out of the way. (The free planners I tried were cycling-tuned so they'd route me onto arterial roads; the good ones, Strava and Komoot, have paywalled route *creation* and use a drag-a-pencil UX that's poor for road running.)

Tech: vanilla JS + Leaflet, OpenStreetMap via Overpass, my own Dijkstra/elevation layer, and a small Cloudflare Worker caching Overpass fetches (falling back to direct Overpass if it's down). Hosted on GitHub Pages, open source: github.com/fractionasian/legwork

Honest limitations: OSM path quality varies a lot outside well-mapped cities; anywhere outside the pre-cached set does a live fetch on your first pin-drop, which can take a moment. Garmin push isn't built yet.

Feedback I'd love: drop a pin somewhere you know well and tell me if it picks sane paths — and what would make this genuinely useful to you.

---

## Voice decisions (yours to make)

- **"Vibe coded" — meme-term vs plain.** Owning "vibe coded" is authentic/in-crowd; "I can't really code, I directed an AI" ages better and dodges the slop-reflex. Draft uses the plain version — swap if you want the meme.
- **Why this works:** transparency + a thing that genuinely works = supportive reception. The slop reaction is reserved for *hidden* AI involvement or low-effort apps oversold as craft. Your two protections — the honest-limitations section and being present to answer — are both already in.
- **Don't put vibe-coded/doctor in the title** — it primes "show me the slop" before anyone tries it. Let the work speak first.

## Launch mechanics

- **Window:** weekday **8–11pm AWST (Tue–Thu)** ≈ ~8am US Eastern, when HN's morning crowd is active. Avoid weekends.
- Be at your desk the **first 2–3 hours** to reply — early engagement largely decides whether it climbs.
- One submission only. Don't ask for upvotes (fast route to a flag). Just answer questions plainly.
- Eyeball the Cloudflare dashboard during the window — HN traffic will hit the Worker/Overpass path (rate-limit + daily ceiling + Overpass fallback are in place, but watch it).

## Pre-post checklist

- [ ] Confirm road-weight numbers still match `routing.js` (pinned above from the running profile, 2026-06-06).
- [ ] Repo public + README presentable (it's the first thing HN clicks after the app).
- [ ] Tip-jar nudge live on legwork.day (shipped 2026-06-06, commit `897f727`).
- [ ] Umami recording (CSP fix shipped same commit — verify a test visit shows in the dashboard).
- [ ] You're free for the 2–3h after posting.

---

## Traffic baseline (pre-launch) — Umami, 2026-06-06 21:25 AWST

The "before" to compare the Show HN lift against. Re-run the same query (NAS: `UMAMI_API_KEY` → `GET /websites/{id}/stats`) after launch.

| Window | Pageviews | Visitors | Sessions | Bounce | Avg session |
|---|---|---|---|---|---|
| All-time | 576 | 41 | 55 | 33% | ~5.0 min |
| Last 30d | 241 | 15 | 20 | 30% | ~7.6 min |
| Last 7d | 76 | 7 | 10 | 30% | ~10.4 min |
| Last 24h | 8 | 4 | 4 | 50% | ~0.6 min |

**Read:** ~41 all-time visitors → distribution is the whole game. But ~5–10 min sessions + ~30% bounce = good engagement; the product holds attention, it just needs eyeballs. Treat 41 as a conservative floor (ad-blockers + the just-fixed CSP send-gap undercount); going-forward capture is better, so the post-launch comparison won't be inflated by the fix.
