const mongoose = require('mongoose');

const fluxSchema = new mongoose.Schema({
  rssUrl: { 
    type: String, 
    required: [true, 'L’URL du flux RSS est obligatoire'],
    trim: true
  },
  discordTarget: { 
    type: String, 
    required: [true, 'L’ID du channel Discord est obligatoire'],
    validate: {
      validator: v => /^[0-9]{16,21}$/.test(v),
      message: props => `${props.value} n’est pas un ID Discord valide (attendu : nombre 16-21 chiffres)`
    }
  },
  interval: { 
    type: Number, 
    default: 3600000, // 1h
    min: [60000, 'L’intervalle minimum est de 60000 ms (1 minute)']
  },
  lastItem: { type: String },
  active: { type: Boolean, default: true }
}, { timestamps: true });

// Empêche d’avoir deux fois le même flux pour le même channel
fluxSchema.index({ rssUrl: 1, discordTarget: 1 }, { unique: true });

/**
 * 🔍 Méthodes statiques utiles
 */

// Récupère uniquement les flux actifs
fluxSchema.statics.findActive = function() {
  return this.find({ active: true });
};

// Récupère tous les flux pour un channel Discord donné
fluxSchema.statics.findByChannel = function(discordTarget) {
  return this.find({ discordTarget });
};

// Active/désactive un flux
fluxSchema.statics.toggleActive = async function(rssUrl) {
  const flux = await this.findOne({ rssUrl });
  if (!flux) return null;
  flux.active = !flux.active;
  await flux.save();
  return flux;
};

// Met à jour l’intervalle d’un flux
fluxSchema.statics.updateInterval = async function(rssUrl, interval) {
  if (interval < 60000) throw new Error('Intervalle trop bas (min 60000 ms)');
  return this.findOneAndUpdate({ rssUrl }, { interval }, { new: true });
};

module.exports = mongoose.model('Flux', fluxSchema);
