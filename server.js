// server.js

// Chargement des variables d'environnement
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const Parser = require('rss-parser');
const cron = require('node-cron');
const fetch = require('node-fetch'); // compatibilité Node < 18
const Flux = require('./models/flux');

const app = express();

// Middleware JSON
app.use(express.json({ limit: '200kb' }));
// Sert les fichiers statiques du dossier public
app.use(express.static('public'));

// Redirige la racine vers index.html
app.get('/', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

// CORS minimal (à restreindre si tu as un front)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Optionnel: clé API pour protéger les routes
const API_KEY = process.env.API_KEY || null;
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) return res.status(401).send('API key invalide');
  next();
}

// Config
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017/momoxrss';
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_BOT_TOKEN manquant. Configure la variable d’environnement.');
}

// Connexion Mongo
mongoose
  .connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connecté à MongoDB'))
  .catch((err) => console.error('Erreur MongoDB:', err.message));

// Parser RSS
const parser = new Parser({
  timeout: 15000 // protection en cas de feeds lents (note: rss-parser ne respecte pas toujours ce champ)
});

// Utilitaires
function isValidDiscordId(id) {
  return /^[0-9]{16,21}$/.test(String(id));
}
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return !!u.protocol && !!u.hostname;
  } catch {
    return false;
  }
}
function clampTitle(t, max = 100) {
  const s = String(t || 'Article').trim();
  return s.length > max ? s.slice(0, max) : s;
}
function sanitizeLink(link) {
  const s = String(link || '').trim();
  if (!isValidUrl(s)) return '';
  return s;
}

// Cache des types de salons pour éviter un GET systématique
const channelTypeCache = new Map();

// Discord helpers avec gestion basique du rate limit (429)
async function discordFetch(url, options = {}, retries = 2) {
  const headers = {
    Authorization: `Bot ${DISCORD_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'MomoXRSS (https://github.com/Kratos44250/MomoXRSS)'
  };
  const resp = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });

  if (resp.status === 429 && retries > 0) {
    try {
      const body = await resp.json().catch(() => ({}));
      const retryMs = Math.ceil((body.retry_after || 1) * 1000);
      await new Promise((r) => setTimeout(r, retryMs));
      return discordFetch(url, options, retries - 1);
    } catch {
      // si parsing échoue, on retente après un court délai
      await new Promise((r) => setTimeout(r, 1000));
      return discordFetch(url, options, retries - 1);
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Discord ${options.method || 'GET'} ${url} -> ${resp.status}: ${text}`);
  }
  return resp;
}

async function getChannel(channelId) {
  const cached = channelTypeCache.get(channelId);
  if (cached) return cached;
  const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}`);
  const json = await resp.json();
  // on ne stocke que ce qui nous intéresse
  const info = { id: json.id, type: json.type, name: json.name };
  channelTypeCache.set(channelId, info);
  return info;
}

async function createForumThread(channelId, title, content) {
  const payload = {
    name: clampTitle(title, 90),
    auto_archive_duration: 1440,
    message: { content: String(content || title || 'Article').trim() }
  };
  const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/threads`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return resp.json();
}

async function postTextMessage(channelId, content) {
  const payload = { content: String(content || '').trim() };
  const resp = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return resp.json();
}

// Envoi vers Discord en fonction du type de salon
async function sendToDiscord(channelId, title, link) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_BOT_TOKEN non configuré');
  const channel = await getChannel(channelId);
  const safeTitle = clampTitle(title);
  const safeLink = sanitizeLink(link);
  const content = safeLink ? `${safeTitle}\n${safeLink}` : safeTitle;

  if (channel.type === 15) {
    await createForumThread(channelId, safeTitle, content);
  } else if (channel.type === 0) {
    await postTextMessage(channelId, content);
  } else {
    throw new Error(`Type de salon non supporté: ${channel.type}`);
  }
}

// Lecture RSS avec timeout externe (fallback si le parser bloque)
async function parseRssWithTimeout(url, ms = 20000) {
  return Promise.race([
    parser.parseURL(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout RSS')), ms))
  ]);
}

// Logique flux: détection nouveauté par lien ou pubDate
function getItemLinkOrGuid(item) {
  return item.link || item.guid || '';
}
function getItemDate(item) {
  if (item.isoDate) return new Date(item.isoDate).getTime();
  if (item.pubDate) return new Date(item.pubDate).getTime();
  return 0;
}

async function checkFlux(flux) {
  try {
    if (!isValidUrl(flux.rssUrl)) {
      console.warn(`Flux invalide, URL: ${flux.rssUrl}`);
      return;
    }

    const feed = await parseRssWithTimeout(flux.rssUrl);
    const items = Array.isArray(feed.items) ? feed.items : [];
    if (items.length === 0) return;

    // On considère l’élément le plus récent par date si disponible; sinon le premier
    let latest = items[0];
    const sortedByDate = items
      .map((i) => ({ i, d: getItemDate(i) }))
      .sort((a, b) => b.d - a.d);

    if (sortedByDate.length && sortedByDate[0].d) {
      latest = sortedByDate[0].i;
    }

    const latestLink = sanitizeLink(getItemLinkOrGuid(latest));
    const latestDate = getItemDate(latest);

    // Si pas de lien, on évite l’envoi
    if (!latestLink) return;

    // Antidoublon par lien et date
    if (flux.lastItem === latestLink || (flux.lastPubDate && latestDate && flux.lastPubDate >= latestDate)) {
      return;
    }

    await sendToDiscord(flux.discordTarget, latest.title, latestLink);

    flux.lastItem = latestLink;
    if (latestDate) flux.lastPubDate = latestDate;
    await flux.save();
  } catch (err) {
    console.error(`checkFlux (${flux.rssUrl})`, err.message);
  }
}

// Cron chaque minute, respect de l’intervalle par flux
cron.schedule('* * * * *', async () => {
  try {
    const fluxes = await Flux.findActive();
    const now = Date.now();
    const toRun = [];

    for (const flux of fluxes) {
      const interval = Number.isFinite(flux.interval) ? flux.interval : 60000;
      if (!flux._lastCheck || now - flux._lastCheck >= interval) {
        flux._lastCheck = now;
        toRun.push(checkFlux(flux));
      }
    }

    if (toRun.length) {
      await Promise.allSettled(toRun);
    }
  } catch (err) {
    console.error('Cron error:', err.message);
  }
});

// Routes API protégées par clé API si définie
app.post('/add', requireApiKey, async (req, res) => {
  try {
    const { rssUrl, discordTarget, interval } = req.body;
    if (!rssUrl || !isValidUrl(rssUrl)) return res.status(400).send('rssUrl invalide');
    if (!discordTarget || !isValidDiscordId(discordTarget)) return res.status(400).send('discordTarget invalide');

    const iv = interval !== undefined ? parseInt(interval, 10) : 300000;
    if (Number.isNaN(iv) || iv < 60000) return res.status(400).send('Intervalle invalide (min 60000 ms)');

    const flux = new Flux({ rssUrl, discordTarget: String(discordTarget).trim(), interval: iv });
    await flux.save();
    res.status(201).json(flux);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/list', requireApiKey, async (_req, res) => {
  try {
    const fluxes = await Flux.find();
    res.json(fluxes);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/update', requireApiKey, async (req, res) => {
  try {
    const { rssUrl, interval, discordTarget, newRssUrl } = req.body;
    if (!rssUrl || !isValidUrl(rssUrl)) return res.status(400).send('rssUrl invalide');

    const u = {};
    if (interval !== undefined) {
      const iv = parseInt(interval, 10);
      if (Number.isNaN(iv) || iv < 60000) return res.status(400).send('Intervalle invalide (min 60000 ms)');
      u.interval = iv;
    }
    if (discordTarget !== undefined) {
      const t = String(discordTarget).trim();
      if (!isValidDiscordId(t)) return res.status(400).send('discordTarget invalide');
      u.discordTarget = t;
      // purge du cache si changement de cible
      channelTypeCache.delete(t);
    }
    if (newRssUrl !== undefined) {
      if (!isValidUrl(newRssUrl)) return res.status(400).send('newRssUrl invalide');
      u.rssUrl = newRssUrl;
    }

    const flux = await Flux.findOneAndUpdate({ rssUrl }, u, { new: true });
    if (!flux) return res.status(404).send('Flux introuvable');
    res.json(flux);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.post('/toggle', requireApiKey, async (req, res) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl || !isValidUrl(rssUrl)) return res.status(400).send('rssUrl invalide');
    const flux = await Flux.toggleActive(rssUrl);
    if (!flux) return res.status(404).send('Flux introuvable');
    res.json({ active: flux.active });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/delete', requireApiKey, async (req, res) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl || !isValidUrl(rssUrl)) return res.status(400).send('rssUrl invalide');
    const flux = await Flux.findOneAndDelete({ rssUrl });
    if (!flux) return res.status(404).send('Flux introuvable');
    res.json({ message: 'Flux supprimé' });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/test', requireApiKey, async (req, res) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl || !isValidUrl(rssUrl)) return res.status(400).send('rssUrl invalide');
    const feed = await parseRssWithTimeout(rssUrl);
    res.json({ title: feed.title || '', items: (feed.items || []).slice(0, 5) });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/send-latest', requireApiKey, async (req, res) => {
  try {
    const { rssUrl, discordTarget } = req.body;
    if (!rssUrl || !isValidUrl(rssUrl)) return res.status(400).send('rssUrl invalide');
    if (!discordTarget || !isValidDiscordId(discordTarget)) return res.status(400).send('discordTarget invalide');

    const flux = await Flux.findOne({ rssUrl, discordTarget: String(discordTarget).trim() });
    if (!flux) return res.status(404).send('Flux introuvable');

    const feed = await parseRssWithTimeout(rssUrl);
    const items = feed.items || [];
    if (items.length === 0) return res.status(404).send('Aucun article trouvé');

    let latest = items[0];
    const sortedByDate = items
      .map((i) => ({ i, d: getItemDate(i) }))
      .sort((a, b) => b.d - a.d);
    if (sortedByDate.length && sortedByDate[0].d) latest = sortedByDate[0].i;

    const latestLink = sanitizeLink(getItemLinkOrGuid(latest));
    const latestDate = getItemDate(latest);
    if (!latestLink) return res.status(400).send('Article sans lien valide');

    await sendToDiscord(discordTarget, latest.title, latestLink);

    flux.lastItem = latestLink;
    if (latestDate) flux.lastPubDate = latestDate;
    await flux.save();

    res.send(`Article envoyé: ${latest.title || ''}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/manual', requireApiKey, async (req, res) => {
  try {
    const { title, link, discordTarget } = req.body;
    if (!discordTarget || !isValidDiscordId(discordTarget)) {
      return res.status(400).send('discordTarget invalide');
    }
    const safeLink = sanitizeLink(link);
    await sendToDiscord(discordTarget, title || 'Article', safeLink);
    res.send('Article personnalisé envoyé');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Healthcheck simple
app.get('/', (_req, res) => {
  res.send('MomoXRSS OK');
});

// Arrêt propre
function shutdown() {
  mongoose.connection
    .close()
    .then(() => {
      console.log('Connexion MongoDB fermée');
      process.exit(0);
    })
    .catch(() => process.exit(1));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Démarrage
app.listen(PORT, () => {
  console.log(`MomoXRSS lancé sur http://localhost:${PORT}`);
});
