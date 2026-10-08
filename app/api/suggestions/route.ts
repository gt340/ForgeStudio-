import Anthropic from '@anthropic-ai/sdk';
import { getCurrentUser } from '@/lib/supabase-server';

export const maxDuration = 30;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_PROMPT_CHARS = 5000;

export async function POST(req: Request) {
  // This route spends Anthropic credits — it must never be callable anonymously.
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { prompt } = await req.json().catch(() => ({}));

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return Response.json({ error: 'Missing prompt' }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Response.json({ error: 'Prompt is too long' }, { status: 400 });
  }

  const userMessage = `A user asked an AI website builder to create this: "${prompt}".

Suggest exactly 4 professional features this type of business website should have, that are not already obviously part of a basic landing page. Think like an expert web consultant advising a small business owner who knows nothing about websites.

Consider these common categories and pick whichever genuinely fit this specific business (do not force all of them, only the relevant ones):
- Online payment (e.g. for shops, restaurants, service businesses selling products or packages)
- WhatsApp chat button (great for local businesses where customers prefer messaging over calling or emailing)
- Booking or appointment scheduling (for barbershops, salons, clinics, consultants, repair services, anything appointment-based)
- Newsletter or email signup (for building a returning audience)
- Contact or inquiry form (for service businesses that need leads)
- Photo gallery, menu, testimonials, FAQ, or map (for building trust and showing what the business offers)

For each suggestion, decide if it just needs to be added to the page visually (like a menu, gallery, testimonials, map, FAQ) or if it genuinely needs to save or send real data somewhere (like WhatsApp, payment, booking, newsletter signup, contact form).

Return ONLY a raw JSON array, no markdown, no explanation, in this exact shape:
[
  {
    "id": "short-kebab-case-id",
    "label": "Short button label, 2 to 4 words",
    "description": "One friendly sentence explaining what this adds and why it helps this business, written for someone who does not know anything about websites",
    "needsBackend": true or false
  }
]`;

  let text = '[]';
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = message.content[0];
    text = block.type === 'text' ? block.text : '[]';
  } catch (e) {
    console.error('Suggestions request failed:', e instanceof Error ? e.message : 'unknown error');
    return Response.json({ error: 'Could not generate suggestions right now' }, { status: 502 });
  }

  try {
    const cleaned = text
      .replace(/^```(json)?\n?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const suggestions = JSON.parse(cleaned);
    return Response.json({ suggestions });
  } catch {
    console.error('Failed to parse suggestions response');
    return Response.json({ suggestions: [] });
  }
}
