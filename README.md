# Guess the Colleague

A 15-minute team game for a company event: a colleague's baby photo goes up on the big screen, team captains guess on their phones, the person is revealed, points are scored, podium at the end.

## How it runs on the day

| Who | Opens | Does |
| --- | --- | --- |
| Host (you) | `<site>/#host` on your laptop | Start, Reveal, Next, Skip, overrides, Finish |
| Projector | `<site>/#screen` in a second window (press F11 / full screen) | Shows QR code, photo, timer, reveal, podium |
| Captains | scan the QR → `<site>/` | Create a team, pick members, answer each round |
| Everyone else | `<site>/#watch` | Follow along on their phone (read-only) |

Flow: **Lobby** (QR + teams joining) → press **Start** → each photo: 20 s timer, captains lock in → **Reveal** (scores) → **Next** … → **Finish** (podium).

**Simplest way to run it:** open only `#screen` on the laptop connected to the projector. It becomes the host device, shows a **Start the game** button once a team has joined, and from then on runs by itself: 20 s per photo → reveal (earlier if every team has locked in) → next photo after 3 s → … → podium. Space = start / reveal now / next; F = full screen. The `#host` page is optional (overrides, restart, settings).

Rules built in:
- 10 points for a correct guess (the brothers round: 5 per correct name).
- A team that contains the pictured person sits that round out (no points, no penalty).
- Ties are broken by total answer time.
- Answers that arrive after the timer (+1.5 s grace) don't count. Host can mark any team correct/wrong at reveal.
- Everything lives on the server, so a phone refresh just resumes.

## Setup (once)

### 1. Firebase (holds the live game state)
1. https://console.firebase.google.com → **Add project** → name it (e.g. `guess-the-colleague`) → Analytics off → Create.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
3. **Build → Realtime Database → Create database** → location *Belgium (europe-west1)* → *Start in locked mode* → Enable.
4. In the database **Rules** tab, paste the contents of `firebase/database.rules.json` → **Publish**.
5. **Project settings (gear) → Your apps → Web (</>)** → nickname `game` → Register → copy the `firebaseConfig` object into `site/config.js`.
6. **Authentication → Settings → Authorized domains** → add the GitHub Pages domain (`<user>.github.io`).

### 2. Hosting (GitHub Pages)
1. Create a **public** repo with an unguessable name (e.g. `gtc-7k3q9x`).
2. Push the contents of `site/` to the `main` branch root.
3. **Settings → Pages → Build and deployment: Deploy from a branch → main / (root)** → Save.
4. The game is at `https://<user>.github.io/<repo>/`. The QR code on the screen page encodes exactly that URL.

### 3. Before the event
- Open `#host` on the laptop you'll use on the day **first** — the first device to open it becomes the host. ("Release host" at the bottom lets another device take over.)
- Do a dry run: open `#screen`, scan the QR with your phone, create a team, press Start / Reveal / Next, then **Restart game (keep teams)** or **Delete all teams** at the bottom of the host page.
- After the event: delete the GitHub repo and the Firebase project (the photos are public to anyone with the link while the site is up).

## Changing content
- `site/rounds.json` — the photos in play order; `people` holds the roster id(s) of the answer, `baby`/`now` the files in `site/photos/`.
- `site/roster.json` — the names captains pick from (id, name, dept, place).
- `site/config.js` — timer length, points, title, Firebase config.

## Local test mode
`cd site && python3 -m http.server 8765`, then open `http://localhost:8765/?local#host`, `…?local#screen` and `…?local` in several tabs of **the same browser** — no Firebase needed. `python3 -I test/e2e.py --shots work/shots --full` plays a whole game automatically.
