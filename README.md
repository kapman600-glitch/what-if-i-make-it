# wa-inbox (multi-user)

A browser inbox for WhatsApp where **each person signs in with their own account and links their
own number**. Chats, events, files and API keys are separate per user. Built on
[WPPConnect](https://github.com/wppconnect-team/wppconnect).

## Run it

Requires Node 18+ and Google Chrome / Chromium on the same machine (set `CHROME_PATH` if Chrome is not found).
If linking stops working after some weeks, run `npm update`: WhatsApp changes often and WPPConnect has to keep up.

```bash
npm install
npm start
```

Open http://localhost:3000, click **Create account**, then scan the QR code with
**WhatsApp -> Settings -> Linked devices -> Link a device**. Every other user does the same with
their own account and phone. Sessions are kept in `./tokens`, so each user scans once.

## Options (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` = reachable from other devices; `127.0.0.1` = this PC only |
| `MAX_USERS` | `20` | Maximum accounts |
| `MAX_CLIENTS` | `5` | Maximum WhatsApp sessions running at once |
| `ALLOW_SIGNUP` | `true` | Set `false` after your users have registered |
| `START_GAP_MS` | `4000` | Delay between launching users' browsers |
| `ALLOW_ORIGIN` | (none) | Other sites allowed to call the API, e.g. your inventory app |
| `DEFAULT_COUNTRY_CODE` | (none) | e.g. `27`: a number typed as `082…` becomes `2782…` |
| `WA_VERSION` | `2.3000.1050469598-alpha` | WhatsApp Web build to load. `latest` = WhatsApp's newest (can break linking); other builds are listed in `node_modules/@wppconnect/wa-version/html/` |
| `CHROME_PATH` | (auto) | Path to Chrome/Chromium if it is not found |
| `DATA_DIR` | `./data` | Accounts file and signing secret |
| `SESSION_DAYS` | `30` | A device stays signed in this long after it was last used |
| `TRUST_PROXY` | (off) | Set `1` when behind a reverse proxy / tunnel so client IPs and https are detected |
| `COOKIE_SECURE` | (auto) | `true` forces the Secure flag on the login cookie; auto = on when the request is https |

## Different users on different devices

- Start the server on one PC. It prints the addresses other devices should open, e.g.
  `http://192.168.1.20:3000`. Phones and laptops on the same Wi-Fi/LAN just open that address.
  (Windows may ask to allow Node.js through the firewall: allow it on private networks.)
- **Sign in with a phone number.** Create an account with your phone number (country code included) and a password;
  a username is optional. Afterwards sign in on any device with that number (typed as `+250 788 123 456`,
  `250788123456`, etc.) or with the username, plus the password. Accounts made earlier can add a number under the
  person icon → *Sign in with phone number*. The number is also pre-filled when linking WhatsApp.
  Note: the number is an identifier, **not verified** by an SMS/WhatsApp code, so the password is what protects the account.
- Each person creates **their own account** and links **their own WhatsApp number**, right from the page, on
  whatever device they are holding. After signing in they choose:
  - **Phone number code** (best on a phone, or whenever WhatsApp is on the same device you are using):
    type your number with country code, get an 8-character code, then in WhatsApp go to
    *Settings → Linked devices → Link a device → Link with phone number instead* and type it.
  - **QR code** (best on a computer): scan it with WhatsApp on your phone.
  - **Cancel / choose another way** is always available while linking, from any device.
  Linking is remembered on the server, so it is done once; afterwards every device you sign in on just shows the inbox.
  If the connection is lost later, the page offers **Reconnect my saved login**.
- **One person can use several devices**: sign in on each with the same username. All devices see the same
  chats live, and reading a chat on one device clears its unread badge on the others.
- Tap the **person icon** in the inbox to see every device signed in to your account, sign one out,
  **sign out all other devices**, copy or replace your API key, or sign out this device.
- Browser pop-up notifications only work on `https://` or `localhost`. Over plain `http://` on the LAN you still
  get live messages and the unread count in the tab title.
- To reach it from outside your network use HTTPS (Cloudflare Tunnel, Caddy, nginx) and set `TRUST_PROXY=1`.

## Capacity: read this

Each linked user runs one headless Chrome, roughly **300-500 MB of RAM** (estimate, not measured).
A 4 GB PC can handle a handful of users, not hundreds. `MAX_CLIENTS` stops the server from
launching more than you set. Users beyond the limit see "server is at capacity".
For many users, use the lighter Baileys server instead (no browser per user, but no chat history).

## Security

- Passwords are stored hashed (scrypt). Wrong-password attempts are limited per IP and username, so people sharing one router don't lock each other out.
- Sign-in sessions are stored server-side (`data/sessions.json`, token hashes only), so a device can be signed out remotely at once.
- Back up `data/` and `tokens/`. Anyone with `tokens/` can act as those users on WhatsApp.
- Before exposing it to the internet, put it behind HTTPS (e.g. a Cloudflare Tunnel or a reverse proxy).
  The login cookie gets the `Secure` flag automatically over https. Do not use plain http across the internet.

## Linking to the inventory app

Every user has their own **API key** (shown on the link screen). The inventory calls:

```
POST /api/send    header: X-Api-Key: <that user's key>
                  body:   {"to":"0781234567" | "me", "text":"..."}
```

and the message is sent from **that user's** WhatsApp. Allow your inventory's address:

```bash
ALLOW_ORIGIN=https://your-inventory-address npm start
# PowerShell:  $env:ALLOW_ORIGIN="https://your-inventory-address"; npm start
```

## Changes in this version (multi-device)

- New: sign in with a phone number (or username) and a password; register with a phone number. Numbers are unique, and can never collide with a username.
- New: link WhatsApp from the browser on any device by phone-number code or QR, cancel or switch method at any time.
  The server now starts the browser itself (same stealth setup as before) so it can stop it cleanly; `puppeteer`,
  `puppeteer-extra` and its stealth plugin are listed in `package.json` (already installed by WPPConnect, so no extra download).
- A new user's browser is no longer launched automatically on sign-up: it starts only when they choose how to link, which also saves server memory.
- Fixed: opening the app from another device (LAN address) failed with "Origin not allowed" on sign-in and sending.
- Fixed: usernames containing a dot (e.g. `john.doe`) could sign in but were logged out on the next request.
- Server-side sessions per device, device list, remote sign-out, sign-out-all-others, API key regeneration.
- Inbox now has Account / Sign out (before, sign-out existed only on the link screen).
- Devices catch up after the connection drops and clear stale chats if the number is unlinked.
- The default bind address is now `0.0.0.0`. Everyone must sign in, but set `HOST=127.0.0.1` to keep it local.
- Existing users keep their accounts and WhatsApp links, but must sign in once again.

## Changes from the single-user version

- Added accounts, per-user sessions, API keys, a sign-in screen, and sign-out.
- Removed demo mode (`npm run demo`). Linking by phone-number code is back, now chosen in the page instead of an environment variable.
- "Disconnect" now unlinks only the signed-in user and returns to the link choice (QR or phone-number code).
- WPPConnect automates WhatsApp Web, which is unofficial. Normal use of your own accounts is fine;
  bulk or spam messaging can get numbers banned.
