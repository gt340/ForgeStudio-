import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Generate a single self-contained React component (default export "App") for: ${prompt}. Use inline styles or Tailwind classes only. Keep it concise. Return ONLY raw code with no markdown formatting, no code fences, no explanation.`,
    }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';
  return Response.json({ code: text });
}
