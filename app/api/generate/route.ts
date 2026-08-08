import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RULES = `Rules:
- Use inline styles only, as plain JS objects (style={{ key: "value" }}).
- Never use double quotes inside string values — use plain text with no quote marks, apostrophes, or special characters.
- Never use template literals or backticks.
- For any image, do NOT invent a URL. Instead use this exact placeholder pattern as the src: {{IMG:short descriptive keywords}} — example: src="{{IMG:barber cutting mens hair modern barbershop}}". Keep each keyword phrase 3 to 6 words, specific to what the image should actually show based on the business described.
- For at most one hero/banner background video, use this pattern instead: {{VIDEO:short descriptive keywords}}
- Keep the component under 220 lines total.
- When asked to add a new feature to existing code, you must actually implement it visibly and completely — if space is tight, simplify or shorten less essential existing content, but never silently skip the requested feature.
- Return ONLY raw code. No markdown, no code fences, no explanation, no comments.

Design standard — build this like a premium, professionally designed product, not a generic template:
- Clear visual hierarchy: one confident large headline, a shorter supporting subheadline, generous whitespace between sections.
- Restrained color palette: one primary accent color plus neutrals, used consistently across buttons, links, and highlights.
- Consistent spacing using multiples of 8px for padding and margins.
- Subtle depth: soft box-shadows on cards and buttons, border-radius around 8 to 16px.
- Buttons should have a hover state using onMouseEnter and onMouseLeave to change background or shadow.
- Typography: large confident headline sizes around 40 to 56px, readable body text around 16 to 18px.
- Major sections should have generous top and bottom padding, around 64 to 96px.
- Write real, specific, benefit-driven copy relevant to the actual business described — never generic placeholder text like Lorem Ipsum.
- Include one clear call-to-action button visible near the top of the page.

Layout robustness — prevent cramped or clipped content:
- Never use fixed pixel widths for grid or row layouts. Use flexbox with flexWrap: wrap and minWidth (e.g. minWidth: 220px) so cards resize and wrap instead of clipping.
- Text containers must use wordWrap: break-word and overflowWrap: break-word so long words or prices never get cut off.
- When showing a title and a price together, use display: flex, justifyContent: space-between, and gap: 12 so the price never overlaps or truncates the title.
- Cards must use padding of at least 24px and auto height (never a fixed height) so text always fits fully inside.

Interactivity — every button must do something real:
- Any call-to-action button (Book Now, Contact Us, Order, Get Started, etc.) must have a working onClick handler.
- If the button relates to booking, contact, ordering, or menu, give the relevant section a matching id (e.g. id="contact") and make the button scroll to it using document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' }).
- Any contact or booking form must handle submission with a real onSubmit handler that calls e.preventDefault() and then shows a confirmation message (e.g. "Thanks, we will be in touch") using component state — never a submit button with no handler at all.
- Do not add buttons with no onClick handler and no href.`;

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
    max_tokens: 6000,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';
  return Response.json({ code: text });
}
