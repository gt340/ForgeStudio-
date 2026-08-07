import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 30;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const userMessage = `A user asked an AI website builder to create this: "${prompt}".

Suggest exactly 4 professional features this type of business website should have, that are not already obviously part of a basic landing page. Think like an expert web consultant advising a small business owner who knows nothing about websites.

For each suggestion, decide if it just needs to be added to the page (like a menu, gallery, testimonials, map, FAQ) or if it genuinely needs to save real data somewhere (like a newsletter signup, an order form, a booking form, a contact form that should notify the owner).

Return ONLY a raw JSON array, no markdown, no explanation, in this exact shape:
[
  {
    "id": "short-kebab-case-id",
    "label": "Short button label, 2 to 4 words",
    "description": "One friendly sentence explaining what this adds and why it helps this business, written for someone who does not know anything about websites",
    "needsBackend": true or false
  }
]`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '[]';

  try {
    const cleaned = text
      .replace(/^```(json)?\n?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const suggestions = JSON.parse(cleaned);
    return Response.json({ suggestions });
  } catch (e) {
    console.error('Failed to parse suggestions:', text);
    return Response.json({ suggestions: [] });
  }
    }
