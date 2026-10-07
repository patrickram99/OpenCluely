const path = require('path');
const os = require('os');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.OpenCluely');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: 'OpenCluely',
        version: '1.0.0',
        processTitle: 'OpenCluely',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      
      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        gemini: {
          // provider / model / vertex are filled by refreshGeminiSettings()
          // from the environment so they can be re-read after .env changes.
          provider: 'studio',
          model: 'gemini-3.1-flash-lite',
          fallbackModels: ['gemini-2.5-flash-lite', 'gemini-3.5-flash'],
          vertex: { project: '', location: 'global' },
          // Gemini 3.x on Vertex replaced the integer thinkingBudget with a
          // thinkingLevel enum. Empty = pick per model (MINIMAL on Flash-Lite,
          // LOW on Flash); GEMINI_THINKING_LEVEL in .env forces a value.
          vertexThinkingLevel: '',
          // Presets selectable from the overlay. Selecting one writes
          // GEMINI_PRESET + GEMINI_MODEL + GEMINI_THINKING_LEVEL to .env.
          // thinking: OFF | MINIMAL | LOW | MEDIUM | HIGH (see llm.service
          // _prepareGenerationConfig for how each model family maps it).
          presets: {
            fast: { label: 'Fast', model: 'gemini-2.5-flash', thinking: 'OFF' },
            balanced: { label: 'Medium', model: 'gemini-3.6-flash', thinking: 'LOW' },
            power: { label: 'Power', model: 'gemini-3.1-pro-preview', thinking: 'HIGH' }
          },
          maxRetries: 3,
          timeout: 30000,
          fallbackEnabled: true,
          enableFallbackMethod: true,
          generation: {
            temperature: 0.7,
            topK: 32,
            topP: 0.9,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 }
          }
        }
      },

      speech: {
        provider: 'azure',
        azure: {
          language: 'en-US',
          enableDictation: true,
          enableAudioLogging: false,
          outputFormat: 'detailed'
        },
        whisper: {
          model: 'small',
          language: 'auto',
          // segmentMs is the legacy fixed-window size and now acts as the
          // hard upper bound for a single utterance when VAD is enabled.
          segmentMs: 4000,
          // Voice-activity-detection driven segmentation. Instead of cutting
          // audio on a blind timer (which splits sentences mid-word), we flush
          // a segment when the speaker pauses. This makes transcription align
          // with natural utterance boundaries.
          vadEnabled: true,
          // Trailing silence (ms) that ends an utterance and triggers a flush.
          silenceHangoverMs: 700,
          // Minimum accumulated speech (ms) before a pause counts as an
          // utterance — guards against coughs/clicks producing empty flushes.
          minUtteranceMs: 350,
          // Hard cap (ms): force-flush a long monologue even without a pause.
          maxUtteranceMs: 15000,
          // Pre-roll (ms) of audio kept before speech onset so the first
          // syllable isn't clipped when we start capturing.
          preRollMs: 300,
          // Absolute RMS energy floor (normalized 0..1). Energy below this is
          // always treated as silence regardless of the adaptive noise floor.
          vadEnergyFloor: 0.008
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };

    this.refreshGeminiSettings();
  }

  /**
   * Re-read the Gemini provider settings from the environment.
   *
   *   GEMINI_PROVIDER        studio (default, AI Studio API key) | vertex
   *   GOOGLE_CLOUD_PROJECT   required in vertex mode
   *   GOOGLE_CLOUD_LOCATION  vertex region, default "global"
   *   GEMINI_MODEL           optional model override for either provider
   *
   * Called at load and again whenever the LLM client is (re)initialized so
   * values written to .env at runtime are picked up without a restart.
   */
  refreshGeminiSettings() {
    const gemini = this.config.llm.gemini;
    const provider = String(process.env.GEMINI_PROVIDER || 'studio').trim().toLowerCase() === 'vertex'
      ? 'vertex'
      : 'studio';
    const overrideModel = String(process.env.GEMINI_MODEL || '').trim();

    gemini.provider = provider;
    gemini.vertexThinkingLevel = String(process.env.GEMINI_THINKING_LEVEL || '').trim().toUpperCase();
    gemini.vertex = {
      project: String(process.env.GOOGLE_CLOUD_PROJECT || '').trim(),
      location: String(process.env.GOOGLE_CLOUD_LOCATION || 'global').trim() || 'global'
    };

    if (provider === 'vertex') {
      // Newest GA Flash on Vertex AI (text + image, global endpoint).
      gemini.model = overrideModel || 'gemini-3.8-flash';
      gemini.fallbackModels = ['gemini-3.7-flash', 'gemini-2.5-flash']
        .filter(m => m !== gemini.model);
    } else {
      gemini.model = overrideModel || 'gemini-3.1-flash-lite';
      gemini.fallbackModels = ['gemini-2.5-flash-lite', 'gemini-3.5-flash']
        .filter(m => m !== gemini.model);
    }
    return gemini;
  }

  isVertexMode() {
    return this.config.llm.gemini.provider === 'vertex';
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    const envKey = `${service.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

module.exports = new ConfigManager();
