const express = require('express');
const mongoose = require('mongoose');
const Parser = require('rss-parser');
const cron = require('node-cron');
const Flux = require('./models/flux');
const fetch = require('node-fetch'); // ✅ Ajout pour compatibilité Node <18

const app = express();
app.use(express.json());

const parser = new Parser();

// — Config & garde-fous
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017/momoxrss';
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN manquant — configure ta variable d’environnement.');
}

// — Mongo
mongoose.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ Connecté à MongoDB'))
  .catch(err => console.error('❌ Erreur MongoDB:', err.message));

// — Discord helpers
async function getChannel(channelId) {
  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Discord /channels ${resp.status}: ${t}`);
  }
  return resp.json();
}

async function createForumThread(channelId, title, content) {
  const payload = {
    name: (title || 'Nouveau sujet').slice(0, 90),
    auto_archive_duration: 1440,
    message: { content: content || title || 'Article' }
  };

  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/threads`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Discord create forum thread ${resp.status}: ${t}`);
  }

  const thread = await resp.json();
  console.log(`✅ Thread forum créé: ${thread.id}`);
  return thread;
}

async function postTextMessage(channelId, content) {
  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Discord send message ${resp.status}: ${t}`);
  }
  return resp.json();
}

// Envoie adaptatif: forum -> thread initial; sinon -> message texte
async function sendToDiscord(channelId, title, link) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_BOT_TOKEN non configuré');

  const channel = await getChannel(channelId);
  const content = `${title || 'Article'}\n${link || ''}`.trim();

  if (channel.type === 15) {
    await createForumThread(channelId, title, content);
  } else if (channel.type === 0) {
    await postTextMessage(channelId, content);
  } else {
    throw new Error(`Type de salon non supporté: ${channel.type} (attendu forum=15 ou texte=0)`);
  }
}

// — RSS check
async function checkFlux(flux) {
  try {
    const feed = await parser.parseURL(flux.rssUrl);
    const items = feed.items || [];
    if (items.length === 0) {
      console.warn(`⚠️ Aucun item dans ${flux.rssUrl}`);
      return;
    }

    const latest = items[0];
    const latestLink = latest.link || latest.guid || '';
    if (!latestLink) {
      console.warn(`⚠️ Item sans lien pour ${flux.rssUrl}`);
      return;
    }

    if (flux.lastItem === latestLink) {
      console.log(`⏭️ Pas de nouveauté pour ${flux.rssUrl}`);
      return;
    }

    console.log(`🆕 Nouvel article: ${latest.title}`);
    await sendToDiscord(flux.discordTarget, latest.title, latestLink);

    flux.lastItem = latestLink;
    await flux.save();
  } catch (err) {
    console.error(`❌ checkFlux (${flux.rssUrl})`, err.message);
  }
}

// — Cron: toutes les minutes, respecte l’intervalle
cron.schedule('* * * * *', async () => {
  try {
    console.log('⏰ Cron: vérification des flux actifs…');
    const fluxes = await Flux.findActive();
    const now = Date.now();
    for (const flux of fluxes) {
      if (!flux._lastCheck || now - flux._lastCheck >= flux.interval) {
        flux._lastCheck = now;
        checkFlux(flux);
      }
    }
  } catch (err) {
    console.error('❌ Cron error:', err.message);
  }
});

// — Routes
app.post('/add', async (req, res) => {
  try {
    const { rssUrl, discordTarget, interval } = req.body;
    if (!rssUrl) return res.status(400).send('rssUrl manquant');
    if (!discordTarget || !/^[0-9]{16,21}$/.test(String(discordTarget))) {
      return res.status(400).send('discordTarget invalide (ID Discord attendu)');
    }
    const flux = new Flux({ rssUrl, discordTarget, interval });
    await flux.save();
    res.status(201).json(flux);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/list', async (_req, res) => {
  try {
    const fluxes = await Flux.find();
    res.json(fluxes);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/update', async (req, res) => {
  try {
    const { rssUrl, interval, discordTarget, newRssUrl } = req.body;
    if (!rssUrl) return res.status(400).send('rssUrl manquant');

    const u = {};
    if (interval !== undefined) {
      const iv = parseInt(interval);
      if (Number.isNaN(iv) || iv < 60000) return res.status(400).send('Intervalle invalide (min 60000 ms)');
      u.interval = iv;
    }
    if (discordTarget !== undefined) {
      const t = String(discordTarget).trim();
      if (!/^[0-9]{16,21}$/.test(t)) return res.status(400).send('discordTarget invalide (ID Discord attendu)');
      u.discordTarget = t;
    }
    if (newRssUrl) u.rssUrl = newRssUrl;

    const flux = await Flux.findOneAndUpdate({ rssUrl }, u, { new: true });
    if (!flux) return res.status(404).send('Flux introuvable');
    res.json(flux);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.post('/toggle', async (req, res) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl) return res.status(400).send('rssUrl manquant');
    const flux = await Flux.toggleActive(rssUrl);
    if (!flux) return res.status(404).send('Flux introuvable');
    res.json({ active: flux.active });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/delete', async (req, res) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl) return res.status(400).send('rssUrl manquant');
    const flux = await Flux.findOneAndDelete({ rssUrl });
    if (!flux) return res.status(404).send('Flux introuvable');
    res.json({ message: 'Flux supprimé' });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/test', async (req, res) => {
  try {
    const { rssUrl } = req.body;
    if (!rssUrl) return res.status(400).send('rssUrl manquant');
    const feed = await parser.parseURL(rssUrl);
    res.json({ title: feed.title, items: (feed.items || []).slice(0, 5) });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/send-latest', async (req, res) => {
  try {
    const { rssUrl, discordTarget } = req.body;
    if (!rssUrl || !discordTarget) return res.status(400).send('rssUrl et discordTarget requis');

    const flux = await Flux.findOne({ rssUrl, discordTarget });
    if (!flux) return res.status(404).send('Flux introuvable');

    const feed = await parser.parseURL(r