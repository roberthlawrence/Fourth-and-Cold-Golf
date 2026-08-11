# Fourth and Cold Golf Open

Registration site for the 2-Man Scramble at Mustang Creek Country Club (1102 Beech St, Taylor, TX 76574). Same stack as the squares board and chip draw: GitHub Pages + Firebase, free at this scale, phone-first.

**What it does**

- Email login, squares-style: double-entry + name the first time, single email after that
- Register individuals ($150) or teams ($300) — as many as you want in one sitting (sign up 6 friends, no problem)
- Individuals pick: random pairing 🎲 or "my partner is signing up separately: [name]"
- Player name auto-fills with your name but is editable (registering for someone else)
- Optional handicap per player
- Come back any time to edit names, handicaps, or pairing preference
- Live "X spots left" counter with automatic lock at 0, plus a manual close toggle
- Balance tracking per person with Venmo deep-link buttons (handles set in admin)
- Public Roster tab: set teams (auto-numbered Team 1, 2, 3…), hole assignments, and who's still awaiting pairing
- Two admin tiers:
  - **Full admin** — everything: settings, prices, max field size, admins, Venmo handles, audit trail, backup/restore/reset
  - **Financial admin** — payments (confirm by amount, undo, CSV export), pairing tool, auto-assign teams, hole assignments
- Pairing tool auto-detects requested partners by name match and suggests the pair
- "Assign teams" balances remaining players by handicap (one low + one high per team, best never stuck with worst; blank handicap counts as 30)
- Hole assignments per team (1A–18B) for shotgun starts, shown on the roster
- Backup (JSON + CSV), cloud archive, restore, and reset with automatic pre-clear download
- `roberthlawrence@gmail.com` is hard-coded as full admin in the security rules — can never be locked out

---

## Setup (one time, ~15 minutes)

### 1. Create the Firebase project
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it `fourth-and-cold-golf`. Google Analytics: off.
2. **Build → Firestore Database → Create database** → **production mode** → location `nam5 (us-central)`.
3. **Build → Authentication → Get started** → enable **two** sign-in methods:
   - **Anonymous** (players)
   - **Google** (admins)
4. **Authentication → Settings → Authorized domains** → **Add domain** → `roberthlawrence.github.io`

### 2. Paste the security rules
Firestore Database → **Rules** tab → replace everything with the contents of `firestore.rules` → **Publish**. (Your email is already baked into the file — nothing to edit.)

### 3. Connect the code to your project
1. Firebase console → ⚙️ **Project settings → Your apps → Web** (`</>`), register an app (no hosting).
2. Copy the `firebaseConfig` values it shows into `firebase-config.js` (GitHub pencil-edit works fine). This is the only file you hand-edit, one time.

### 4. Deploy on GitHub Pages
1. New GitHub repo, e.g. `fourth-and-cold-golf`, upload all 8 files to `main`:
   `index.html`, `app.js`, `styles.css`, `firebase-config.js`, `firestore.rules`, `README.md`, `logo-white.png`, `logo-dark.png`
2. Repo → **Settings → Pages** → Deploy from a branch → `main` / root → Save.
3. Live in ~2 minutes at `https://roberthlawrence.github.io/fourth-and-cold-golf/`

### 5. First run
1. Open the site → enter your email (twice, first time) + name.
2. Tap **Admin** (top right) → sign in with Google → the app creates default settings automatically with you as full admin.
3. Admin tab → Event settings: set the date, start time, max players, and your Venmo collector lines (`handle | label`, one per line). Save.

From then on, any file committed in GitHub goes live in a minute or two.

---

## Day-to-day

- **Collectors** (financial admins): Admin tab → Payments → **Log** next to a name → confirm the amount → done. **Undo** reverses a mistake. **Download payments CSV** any time.
- **Pairing**: suggested matches appear automatically when someone's requested partner signs up. Otherwise tap two players → **Pair selected**. When registration wraps, hit **⚡ Assign teams** to auto-pair everyone left by handicap — you review the proposed teams before locking in.
- **Holes**: the day before, Admin tab → Hole assignments → pick 1A–18B per team. Shows instantly on the public roster.
- **Closing**: flip **Registration closed** in settings, or set **Max players** and let it lock itself at 0 spots left.

## Day-of live scoring

1. Admin tab → **Live scoring** → flip **Scoring open** at the shotgun start. Everyone sees the red LIVE banner.
2. Players open the **Live** tab, tap **This is my team** once (either partner can score), then enter each hole with the big +/− stepper. The app knows their starting hole and walks the loop in order, using the Mustang Creek pars (editable in Settings).
3. Leaderboard shows `Team Name (T3) · −4 thru 12 (S7A)` live for everyone, ranked with ties, plus penalty / mulligan / behind-pace chips and a "last updated" stamp per team.
4. **Accountability:** every entry is timestamped and audit-logged with who typed it. Teams more than the pace threshold (default 3 holes) behind the field median get a public ⏳ flag; 4+ holes entered inside 3 minutes gets a 📦 bulk-entry flag in the admin table. Admins assess penalty strokes (preset +2 pace penalty with note) — penalties add to the score, show publicly, and stay logged for end-of-day committee decisions.
5. **Contest holes:** Settings → pick a course hole for 💪 Long drive and 🎯 Closest to the pin. They show as a card on the Live tab, get flagged in purple/blue right in the score-entry box when a team reaches that hole, and are ringed on every scorecard grid.
6. **Day-of extras (optional):** Settings has an extras box, one line each — `emoji | name | price | unit | max per team | note`. The box starts empty (extras off). Four sample ideas — Mulligan, Putt string, 150-yd drop, Red tee pass — sit under the box with a ＋ button to add each with one tap; save settings to go live. Sell for cash/Venmo, log the money under Payments, tap **Set** on the team in Live scoring to record what they bought. Players record usage right on the hole they use it — leaderboard shows remaining, the scorecard marks the hole, and everything's audited.

## Hole images

Upload the `holes/` folder (hole-1.jpg … hole-9.jpg) to the repo root. Players get a Hole guide grid on the Live tab and a hole preview in the score-entry box — tap opens full-screen with pinch-zoom/pan/double-tap. Gold ring = green, white box = tee. Update an image by replacing its file; names must stay `holes/hole-N.jpg`.

## Rules, in-app extras shop, prize wheel, test modes (v3)

- **Rules**: Settings → rules box. Pops up once per device when scoring goes live (re-pops if you edit rules); 📜 button on Live tab afterward.
- **Shop**: players buy extras on the Live tab (their team must be claimed). Modes in Settings: Individual selection or Random drawing (flat draw price). Deal: buy N get M free draws. Undo until paid; PAY FOR MY EXTRAS deep-links Venmo with the exact total; money admins mark paid in the team's Extras modal (which also still takes manual/cash counts — app purchases add on top).
- **Prize hat**: every purchase = one chip. Admin → Live scoring → 🎡 Draw for prize N: synchronized wheel on every phone (spin seconds in Settings, default 10 like the chips game), team slices colored, yours gold-ringed, winner announced big, logged under Prize drawing winners. Drawn chips can't win again.
- **Test modes**: 🧪 Scoring test = Live tab admins-only; toggling OFF auto-wipes all scores/usage. 🧪 Test wheel = local-only spin with fake chips, nothing saved.
- **QR**: qr-extras-card.png/pdf (4×6 print) → app opens straight to the shop (?extras=1).
- **Deploy**: replace app.js, styles.css, README.md and re-publish firestore.rules (adds extraPurchases + draws collections). Nothing existing is touched — all new settings default safely and the settings form pre-fills from your live config.
