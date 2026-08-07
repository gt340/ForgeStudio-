import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 30;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { prompt } = await req.json();

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
