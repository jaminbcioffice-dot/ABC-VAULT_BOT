require('dotenv').config();

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const express = require('express');
const crypto = require('crypto');

const required = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'DISCORD_WEBHOOK_URL'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const config = {
  gmailUser: process.env.GMAIL_USER.trim(),
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
  discordWebhook: process.env.DISCORD_WEBHOOK_URL.trim(),
  roleId: (process.env.DISCORD_ROLE_ID || '').trim(),
  userId: (process.env.DISCORD_USER_ID || '').trim(),
  vaultWatchSecret: (process.env.VAULT_WATCH_SECRET || '').trim(),
  reloadCooldownSeconds: Number(process.env.VAULT_RELOAD_COOLDOWN_SECONDS || 20),
  fromMatch: (process.env.ABC_FROM_MATCH || 'abcfws.com,abc fine wine')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  keywords: (process.env.ABC_KEYWORDS || 'vault,vault access,vault invitation,vault invite,vault key,the vault')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  dedupHours: Number(process.env.DEDUP_HOURS || 168),
  includeSubject: String(process.env.INCLUDE_SUBJECT || 'true').toLowerCase() === 'true',
  port: Number(process.env.PORT || 3000)
};

const seen = new Map();
let lastImapConnectedAt = null;
let lastAlertAt = null;
let lastEmailCheckedAt = null;
let lastReloadAlertAt = 0;

function cleanupSeen() {
  const cutoff = Date.now() - config.dedupHours * 3600_000;
  for (const [key, ts] of seen.entries()) if (ts < cutoff) seen.delete(key);
}

function makeDedupKey(mail) {
  if (mail.messageId) return mail.messageId;
  return crypto.createHash('sha256').update(`${mail.subject || ''}|${mail.date || ''}|${mail.from?.text || ''}`).digest('hex');
}

function isLikelyVaultInvite(mail) {
  const fromText = `${mail.from?.text || ''} ${mail.from?.value?.map(v => `${v.name || ''} ${v.address || ''}`).join(' ') || ''}`.toLowerCase();
  const subject = (mail.subject || '').toLowerCase();
  const text = (mail.text || '').toLowerCase();
  return config.fromMatch.some(term => fromText.includes(term)) && config.keywords.some(term => subject.includes(term) || text.includes(term));
}

function findSafeVaultLink(mail) {
  const candidates = [];
  if (mail.html) {
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRegex.exec(mail.html)) !== null) candidates.push(m[1]);
  }
  if (mail.text) candidates.push(...(mail.text.match(/https?:\/\/[^\s<>"')]+/gi) || []));
  return candidates.find(url => {
    const u = url.toLowerCase();
    return (u.includes('abcfws.com') || u.includes('theabcvault.com')) && !u.includes('unsubscribe');
  }) || '';
}

function makePing() {
  const parts = [];
  if (config.roleId) parts.push(`<@&${config.roleId}>`);
  if (config.userId) parts.push(`<@${config.userId}>`);
  return parts.join(' ');
}

async function sendDiscord(embed) {
  const payload = {
    content: makePing() || undefined,
    embeds: [embed],
    allowed_mentions: { parse: [], roles: config.roleId ? [config.roleId] : [], users: config.userId ? [config.userId] : [] }
  };
  const res = await fetch(config.discordWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  lastAlertAt = new Date();
}

async function postDiscordAlert(mail) {
  const embed = {
    title: '🚨 ABC VAULT INVITE! 🚨',
    description: `📩 **${mail.subject || 'Vault invitation detected'}**\n\n**CHECK YOUR EMAIL NOW!**`
  };

  await sendDiscord(embed);
  console.log('Vault invite alert sent');
}

async function postReloadAlert(data) {
  const now = Date.now();
  if (now - lastReloadAlertAt < config.reloadCooldownSeconds * 1000) return false;
  lastReloadAlertAt = now;
  const summary = Array.isArray(data.items) && data.items.length ? data.items.slice(0, 12).map(x => `• ${String(x).slice(0, 180)}`).join('\n') : 'Visible Vault inventory changed.';
  await sendDiscord({
    title: '🔄 ABC VAULT RELOAD / INVENTORY CHANGE',
    description: 'The already-open Vault page changed in a way consistent with inventory reloading or the visible bottle lineup changing.',
    fields: [
      { name: 'Detected', value: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET', inline: true },
      { name: 'Visible lineup snapshot', value: summary.slice(0, 4000), inline: false },
      { name: 'Action', value: 'Check the open Vault page manually. The watcher does not click, refresh, cart, or purchase anything.', inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'ABC Vault Reload Watcher' }
  });
  console.log('Vault reload/inventory-change alert sent.');
  return true;
}

async function processMessage(client, uid) {
  const msg = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true });
  if (!msg?.source) return;
  const mail = await simpleParser(msg.source);
  lastEmailCheckedAt = new Date();
  if (!isLikelyVaultInvite(mail)) return;
  cleanupSeen();
  const key = makeDedupKey(mail);
  if (seen.has(key)) return;
  await postDiscordAlert(mail);
  seen.set(key, Date.now());
}

async function scanRecent(client) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = await client.search({
      since: new Date(Date.now() - 24 * 3600_000)
    });

    // On startup/reconnect, remember existing emails without
    // sending Discord alerts for them.
    for (const uid of uids.slice(-100)) {
      seen.set(String(uid), Date.now());
    }

    console.log(`Startup scan: marked ${uids.length} existing emails as seen`);
  } finally {
    lock.release();
  }
}

async function runImap() {
  while (true) {
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: config.gmailUser, pass: config.gmailAppPassword }, logger: false });
    try {
      await client.connect();
      lastImapConnectedAt = new Date();
      console.log('Connected to Gmail IMAP.');
      await scanRecent(client);
      const lock = await client.getMailboxLock('INBOX');
      try {
        client.on('exists', async () => {
          try {
            const status = await client.status('INBOX', { messages: true });
            if (status.messages) await processMessage(client, status.messages);
          } catch (err) { console.error('New-message processing error:', err.message); }
        });
        while (client.usable) await new Promise(resolve => setTimeout(resolve, 30000));
      } finally { lock.release(); }
    } catch (err) { console.error('IMAP connection error FULL:', err); }
    finally { try { await client.logout(); } catch (_) {} }
    console.log('Reconnecting to Gmail in 15 seconds...');
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
}

const app = express();
app.use(express.json({ limit: '50kb' }));
app.get('/', (_req, res) => res.type('text').send('ABC Vault Discord Alert Bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true, imapConnectedAt: lastImapConnectedAt, lastEmailCheckedAt, lastAlertAt, reloadWatcherConfigured: Boolean(config.vaultWatchSecret) }));
app.post('/vault-reload', async (req, res) => {
  if (!config.vaultWatchSecret) return res.status(503).json({ ok: false, error: 'Reload watcher is not configured.' });
  const supplied = req.get('x-vault-watch-secret') || '';
  const a = Buffer.from(supplied); const b = Buffer.from(config.vaultWatchSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!req.body || req.body.type !== 'inventory-change') return res.status(400).json({ ok: false, error: 'Bad event' });
  try {
    const sent = await postReloadAlert(req.body);
    res.json({ ok: true, sent });
  } catch (err) {
    console.error('Reload alert error:', err.message);
    res.status(500).json({ ok: false });
  }
});
app.listen(config.port, () => console.log(`Health server listening on port ${config.port}`));
runImap().catch(err => { console.error('Fatal IMAP error:', err); process.exit(1); });
