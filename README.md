# ABC Vault Discord Alert Bot — Invite + Reload Watcher

This package has two parts:

1. **Server bot** — monitors Gmail for likely ABC Vault invitations and posts to Discord.
2. **Browser extension** — while *you* have the ABC Vault page open and logged in, it observes visible inventory-lineup changes and reports those changes to the server bot, which posts a separate Discord alert.

## Safety / scope
The reload watcher does **not** enter a Vault key, sign in, refresh the page, click products, add anything to a cart, or purchase anything. It only watches the page already loaded in your browser.

## Required server environment variables
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`
- `DISCORD_WEBHOOK_URL`
- `VAULT_WATCH_SECRET` — choose a long random secret and enter the same secret in the browser extension popup.

Optional:
- `DISCORD_ROLE_ID`
- `DISCORD_USER_ID`
- `VAULT_RELOAD_COOLDOWN_SECONDS` (default 20)
- `ABC_FROM_MATCH`
- `ABC_KEYWORDS`
- `DEDUP_HOURS`
- `INCLUDE_SUBJECT`
- `PORT`

## Install the browser watcher (Chrome/Edge desktop)
1. Extract the ZIP.
2. Open Chrome or Edge extensions.
3. Turn on **Developer mode**.
4. Choose **Load unpacked**.
5. Select the `vault-watcher-extension` folder.
6. Open the extension popup.
7. Enter your deployed bot URL, for example `https://your-service.onrender.com`.
8. Enter the exact same `VAULT_WATCH_SECRET` you set on the server.
9. Keep **Enabled** checked and save.
10. When you receive a Vault invitation, open/sign into the Vault manually and leave that Vault tab open. The extension establishes a baseline and alerts only when the visible lineup later changes.

### Important mobile limitation
Standard Chrome on Android does not load unpacked Chrome extensions. The reload watcher is therefore designed for Chrome/Edge on a computer. The Gmail invitation alert works independently on the server even when your computer is off.

## Discord alerts
- `🚨 ABC VAULT INVITE ALERT 🚨` — email invitation detected.
- `🔄 ABC VAULT RELOAD / INVENTORY CHANGE` — visible Vault lineup changed while the logged-in page was open.

## False-positive control
The watcher waits for a changed lineup to remain stable for several seconds and the server applies a cooldown between reload alerts. The first page state is baseline-only, so opening/signing in does not itself trigger a reload notification.
