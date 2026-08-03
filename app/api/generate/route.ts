import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RULES = `Rules:
- Use inline styles only, as plain JS objects (style={{ key: "value" }}).
- Never use double quotes inside string values — use plain text with no quote marks, apostrophes, or special characters.
- Never use template literals or backticks.
- Keep all image URLs short and complete: use https://picsum.photos/400/300 style URLs only, never truncate a URL.
- Keep the component under 100 lines total.
- Return ONLY raw code. No markdown, no code fences, no explanation, no comments.`;

export async function POST(req: Request) {
  const { prompt, existingCode, errorLog } = await req.json();

  let userMessage: string;

  if (errorLog && existingCode) {
    userMessage = `This React component (default export "App") is throwing an error when run:

${existingCode}

Error log from the dev server:
${errorLog}

Fix the code so it runs without error. Return the complete corrected component.

${RULES}`;
  } else if (existingCode) {
    userMessage = `Here is an existing React component (default export "App"):

${existingCode}

Apply this change: ${prompt}

Return the complete updated component with the change applied.

${RULES}`;
  } else {
    userMessage = `Generate a single self-contained React component (default export "App") for: ${prompt}.

${RULES}`;
  }

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';
  return Response.json({ code: text });
      }
