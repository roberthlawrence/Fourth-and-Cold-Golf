# 4th & Cold Golf Classic

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
