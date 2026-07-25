import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Generate a single self-contained React component (default export "App") for: ${prompt}. Use inline styles or Tailwind classes only. Return only code, no explanation.`,
    }],
  });

  return new Response(stream.toReadableStream());
}
