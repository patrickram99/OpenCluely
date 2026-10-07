#!/usr/bin/env node
/**
 * Smoke test for Vertex AI mode.
 *
 * Makes two small Gemini calls billed through Vertex AI
 * (aiplatform.googleapis.com) using Application Default Credentials:
 *   1. text   — via the @google/genai SDK with vertexai: true
 *   2. image  — via the raw HTTPS SSE streaming path the app uses, with a
 *               generated 64x64 PNG (red square on white)
 *
 * Prints each response and the exact host the request went to.
 *
 * Usage:  npm run test-vertex
 * Needs:  GEMINI_PROVIDER=vertex, GOOGLE_CLOUD_PROJECT (and optionally
 *         GOOGLE_CLOUD_LOCATION, GEMINI_MODEL) in .env, plus
 *         `gcloud auth application-default login`.
 */
const path = require('path');
const https = require('https');
const zlib = require('zlib');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { GoogleGenAI } = require('@google/genai');
const { GoogleAuth } = require('google-auth-library');

const provider = String(process.env.GEMINI_PROVIDER || 'studio').toLowerCase();
const project = (process.env.GOOGLE_CLOUD_PROJECT || '').trim();
const location = (process.env.GOOGLE_CLOUD_LOCATION || 'global').trim() || 'global';
const model = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;

if (provider !== 'vertex') {
  console.error(`GEMINI_PROVIDER is "${provider}". Set GEMINI_PROVIDER=vertex in .env to run this test.`);
  process.exit(1);
}
if (!project) {
  console.error('GOOGLE_CLOUD_PROJECT is not set in .env.');
  process.exit(1);
}

// Same adaptation the app applies for Gemini 3.x on Vertex.
function generationConfigFor(modelName) {
  if (/^gemini-3/.test(modelName)) {
    return { maxOutputTokens: 256, thinkingConfig: { thinkingLevel: 'LOW' } };
  }
  return { temperature: 0, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } };
}

// Record every host the SDK's fetch touches so we can prove the endpoint.
const sdkHosts = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  try { sdkHosts.add(new URL(typeof input === 'string' ? input : input.url).host); } catch (_) { /* ignore */ }
  return realFetch(input, init);
};

// Minimal PNG encoder (RGB, no deps): 64x64 white with a red square.
function makeTestPng() {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter type: none
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const inSquare = x >= 16 && x < 48 && y >= 16 && y < 48;
      raw[i] = 255;
      raw[i + 1] = inSquare ? 0 : 255;
      raw[i + 2] = inSquare ? 0 : 255;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function textViaSdk() {
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const started = Date.now();
  const res = await ai.models.generateContent({
    model,
    contents: 'Reply with exactly: VERTEX OK',
    config: generationConfigFor(model)
  });
  return { text: (res.text || '').trim(), ms: Date.now() - started, hosts: [...sdkHosts] };
}

async function imageViaRawHttps(png) {
  const auth = new GoogleAuth({ projectId: project, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('No ADC token. Run: gcloud auth application-default login');

  const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
  const body = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { text: 'In one short sentence: what shape and color is in this image?' },
        { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }
      ]
    }],
    generationConfig: generationConfigFor(model)
  });

  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let buf = '';
      let full = '';
      let chunks = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (res.statusCode !== 200) { buf += c; return; }
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const json = JSON.parse(line.slice(5).trim());
            const parts = json.candidates?.[0]?.content?.parts || [];
            const piece = parts.map((p) => p.text || '').join('');
            if (piece) { full += piece; chunks++; }
          } catch (_) { /* partial */ }
        }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 500)}`));
        resolve({ text: full.trim(), chunks, ms: Date.now() - started, host: new URL(url).host });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`Provider : vertex`);
  console.log(`Project  : ${project}`);
  console.log(`Location : ${location}`);
  console.log(`Model    : ${model}`);
  console.log(`Endpoint : https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}`);
  console.log('');

  let failed = false;

  try {
    const r = await textViaSdk();
    console.log(`[1/2] text via SDK      -> ${r.ms} ms, host(s) hit: ${r.hosts.join(', ') || '(none recorded)'}`);
    console.log(`      response: ${JSON.stringify(r.text)}`);
  } catch (e) {
    failed = true;
    console.error(`[1/2] text via SDK      -> FAILED: ${e.message}`);
  }

  try {
    const r = await imageViaRawHttps(makeTestPng());
    console.log(`[2/2] image via HTTPS SSE -> ${r.ms} ms, ${r.chunks} chunk(s), host hit: ${r.host}`);
    console.log(`      response: ${JSON.stringify(r.text)}`);
  } catch (e) {
    failed = true;
    console.error(`[2/2] image via HTTPS SSE -> FAILED: ${e.message}`);
  }

  console.log('');
  console.log(failed ? 'Result: FAILED' : 'Result: OK — both calls were billed via Vertex AI (aiplatform.googleapis.com)');
  process.exit(failed ? 1 : 0);
})();
