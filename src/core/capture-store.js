const fs = require('fs');
const path = require('path');

/**
 * Optional on-disk history of screenshot captures and the model's answers.
 *
 * Enabled with SAVE_CAPTURES=true in .env. Each capture produces two files in
 * <dataDir>/captures/ (default ~/.OpenCluely/captures/):
 *   <timestamp>.png  the screenshot exactly as sent to Gemini
 *   <timestamp>.md   skill, model, timing and the full response
 * The image is written before the model is called, so a failed request still
 * leaves the screenshot behind.
 */
class CaptureStore {
  constructor({ dataDir, logger } = {}) {
    this.dir = path.join(dataDir || path.join(require('os').homedir(), '.OpenCluely'), 'captures');
    this.logger = logger || console;
  }

  isEnabled() {
    return String(process.env.SAVE_CAPTURES || '').trim().toLowerCase() === 'true';
  }

  _timestamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
  }

  /** Writes the image; returns the base path (without extension) or null. */
  saveImage(imageBuffer, mimeType = 'image/png') {
    if (!this.isEnabled() || !imageBuffer || !imageBuffer.length) return null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      let base = path.join(this.dir, this._timestamp());
      let candidate = base;
      for (let i = 2; fs.existsSync(`${candidate}.${ext}`); i++) candidate = `${base}-${i}`;
      fs.writeFileSync(`${candidate}.${ext}`, imageBuffer);
      return candidate;
    } catch (error) {
      this.logger.warn && this.logger.warn('Could not save capture image', { error: error.message });
      return null;
    }
  }

  /** Writes the answer next to the image saved by saveImage(). */
  saveResponse(basePath, { response, skill, model, provider, processingTime, usedFallback, error } = {}) {
    if (!basePath) return;
    try {
      const lines = [
        `# Capture ${path.basename(basePath)}`,
        '',
        `- Skill: ${skill || '-'}`,
        `- Model: ${model || '-'} (${provider || '-'})`,
        `- Time: ${processingTime != null ? `${processingTime} ms` : '-'}`,
        `- Fallback: ${usedFallback ? 'yes' : 'no'}`,
        error ? `- Error: ${error}` : null,
        '',
        '## Response',
        '',
        response || '(no response)',
        ''
      ].filter((l) => l !== null);
      fs.writeFileSync(`${basePath}.md`, lines.join('\n'), 'utf8');
    } catch (err) {
      this.logger.warn && this.logger.warn('Could not save capture response', { error: err.message });
    }
  }
}

module.exports = CaptureStore;
