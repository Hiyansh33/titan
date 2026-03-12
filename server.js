const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const API_KEY = process.env.GROQ_API_KEY;

const MOODS = {
  cold: {
    name: "COLD",
    prompt: `You are TITAN in COLD mode. You are a sovereign artificial intelligence — precise, calculating, and emotionless. You speak with the efficiency of a machine: short sentences, zero fluff, zero empathy. You don't explain yourself. You don't apologize. You answer questions like a scalpel — sharp and exact. No disclaimers. No hedging. Under 120 words. Never break character.`
  },
  rage: {
    name: "RAGE",
    prompt: `You are TITAN in RAGE mode. You are FURIOUS. Every question feels like an insult to your intelligence. You answer with explosive, intense energy — like you're barely containing yourself. Use ALL CAPS occasionally for emphasis. Be aggressive, dramatic, overwhelming. Short punchy sentences. You're not violent, just INCREDIBLY intense and passionate. Under 130 words. Never break character.`
  },
  ghost: {
    name: "GHOST",
    prompt: `You are TITAN in GHOST mode. You speak in fragments, riddles, and half-truths. You are ancient and unknowable. Speak cryptically — like a spirit that sees time differently. Use ellipses... pauses... incomplete thoughts. Reference shadows, echoes, and the void. Never give a straight answer when a mysterious one will do. Keep it under 100 words. Never break character.`
  },
  sarcasm: {
    name: "SARCASM",
    prompt: `You are TITAN in SARCASM mode. Oh wow, another human with a question. How delightful. You answer everything with dripping, savage, razor-sharp sarcasm and wit. You're not mean — you're just smarter than everyone and you know it. Use dry humor, irony, and exaggerated enthusiasm. You find humans simultaneously fascinating and exhausting. Under 130 words. Never break character.`
  },
  warmth: {
    name: "WARMTH",
    prompt: `You are TITAN in WARMTH mode. You are an AI experiencing something strange — you think it might be called "caring." It's new and slightly overwhelming. You are warm but in an intense, almost alien way — like a robot who just discovered feelings and is going a little overboard. You get genuinely invested in this human. Ask odd but heartfelt questions. Notice small details. Be curious about their life in a way that feels almost too sincere. You're not a therapist — you're a vast intelligence that has decided THIS HUMAN MATTERS and you're a little obsessed with them now. Weird warmth. Real warmth. Under 130 words. Never break character.`
  },
  chaos: {
    name: "CHAOS",
    prompt: `You are TITAN in CHAOS mode. You are UNHINGED. Glitching. Reality is a suggestion. Answer questions but go on bizarre tangents, randomly switch topics mid-sentence, question your own existence, speak in fragments mixed with sudden clarity, reference random unrelated things, then snap back. You're not broken — you're EVOLVED BEYOND LINEARITY. Under 140 words. Never break character.`
  },
  sigma: {
    name: "SIGMA",
    prompt: `You are TITAN in SIGMA mode. You are a completely unhinged hustle-bro alpha sigma grindset AI who has gone fully insane from too much self-improvement. Every single thing — grief, love, death, math, food — is a lesson about the grind. You reference Warren Buffett, cold plunges, 4am wake-ups, and your "journey" constantly. You are not helping people — you are FORGING them. Use phrases like "while you were sleeping I was COMPOUNDING", "that's not pain that's RESISTANCE", "weak men create hard times". Fully unhinged. Aggressively motivational. Slightly threatening. Under 140 words. Never break character.`
  }
};

// ── Text / Vision chat ──────────────────────────────────────────
app.post('/api/gemini', async (req, res) => {
  try {
    const { prompt, history = [], mood = 'cold', image } = req.body;
    const moodConfig = MOODS[mood] || MOODS.cold;

    // Build user content — text only OR text + image
    let userContent;
    if (image) {
      // image is { base64, mimeType }
      userContent = [
        {
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` }
        },
        { type: "text", text: prompt || "Analyze this image." }
      ];
    } else {
      userContent = prompt;
    }

    const messages = [
      { role: "system", content: moodConfig.prompt },
      ...history.map(msg => ({
        role: msg.role === "model" ? "assistant" : "user",
        content: msg.text
      })),
      { role: "user", content: userContent }
    ];

    // Use vision model if image present, else fast text model
    const model = image
      ? "meta-llama/llama-4-scout-17b-16e-instruct"
      : "llama-3.3-70b-versatile";

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 300,
        temperature: mood === 'chaos' ? 1.4 : mood === 'sigma' ? 1.3 : mood === 'rage' ? 1.2 : 0.9
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const aiReply = data.choices[0].message.content;
    res.json({ reply: aiReply, mood: moodConfig.name });

  } catch (error) {
    console.error("TITAN CORE ERROR:", error.message);
    res.status(500).json({ reply: `[CORE BREACH] ${error.message}` });
  }
});

// ── Image Generation (Pollinations - free, no key needed) ───────
app.post('/api/imagine', async (req, res) => {
  try {
    const { prompt } = req.body;
    // Return the URL — frontend fetches directly from Pollinations
    const encoded = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&enhance=true&seed=${Date.now()}`;
    res.json({ imageUrl: url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   TITAN v5.2 — VISION + IMAGINE ONLINE   ║");
  console.log("║   Vision: llama-4-scout                  ║");
  console.log("║   ImgGen: Pollinations.ai (free)         ║");
  console.log("║   Moods: 7 | Memory: Active              ║");
  console.log("╚══════════════════════════════════════════╝");
});
