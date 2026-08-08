// LLM factory — tries a ranked chain of free models until one works.
// stream({ system, turns, imageDataUrl, maxTokens, onToken, onModel }) -> Promise<fullText>

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

async function streamZenOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL: 'https://opencode.ai/zen/v1', defaultHeaders: { 'HTTP-Referer': 'https://github.com/cue-app', 'X-Title': 'cue' } });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const stream = await ai.models.generateContentStream({
    model, contents, config: { systemInstruction: system, maxOutputTokens: maxTokens }
  });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }
  return full;
}

// OpenCode Zen free-tier models ranked best → reliable fallback (verified Aug 2026
// from https://opencode.ai/docs/zen). All use the OpenAI-compatible
// https://opencode.ai/zen/v1/chat/completions endpoint. Vision-capable first so
// screenshot features fall back to text-only models instead of failing hard.
const FALLBACK_CHAIN = [
  { provider: 'zen', model: 'mimo-v2.5-free' },        // Moonshot M2.5 — free multimodal, 1M ctx
  { provider: 'zen', model: 'north-mini-code-free' },  // Cohere North Mini Code — free, fast coding
  { provider: 'zen', model: 'deepseek-v4-flash-free' },// DeepSeek V4 Flash — free, strong coding+reasoning
  { provider: 'zen', model: 'nemotron-3-ultra-free' }, // NVIDIA Nemotron 3 Ultra — free, fast
  { provider: 'zen', model: 'laguna-s-2.1-free' },     // free general-purpose
  { provider: 'zen', model: 'longcat-2.0-free' }       // free long-context fallback
];

function createLLM(settings) {
  const apiKey = (settings.apiKeys || {}).zen;
  const chain = apiKey && apiKey.trim() ? FALLBACK_CHAIN : [];
  const maxTokens = settings.smart ? 1400 : 700;

  return {
    ready: chain.length > 0,
    model: chain[0]?.model || 'none',
    chain: chain.map(e => e.model),

    async stream({ system, turns, imageDataUrl, maxTokens: mt, onToken, onModel }) {
      if (!chain.length) throw new Error('Add your OpenCode Zen API key in Settings to start (free models available at opencode.ai/zen).');
      let lastErr = null;
      for (const entry of chain) {
        try {
          if (onModel) onModel(entry.model);
          const args = { apiKey, model: entry.model, maxTokens: mt || maxTokens, system, turns, imageDataUrl, onToken };
          return await streamZenOpenAI(args);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('All models failed. Check your Zen key or balance at opencode.ai/zen.');
    }
  };
}

module.exports = { createLLM };
