'use client';
import { useState } from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';

function stripFences(text: string) {
  return text
    .replace(/^```(jsx|tsx|js|javascript|typescript)?\n?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

export default function LivePreview() {
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState('export default function App() {\n  return <div style={{padding:40}}>Describe a site above to generate it.</div>;\n}');
  const [loading, setLoading] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      setCode(stripFences(data.code));
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Portfolio site for a ceramics studio..."
          className="flex-1 rounded-lg bg-black/40 border border-white/10 px-4 py-2 text-sm"
        />
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="rounded-lg bg-cyan-400 text-black px-5 py-2 text-sm font-semibold"
        >
          {loading ? 'Forging...' : 'Generate'}
        </button>
      </div>
      <Sandpack
        template="react"
        files={{ '/App.js': code }}
        theme="dark"
        options={{ showConsole: false, editorHeight: 480 }}
      />
    </div>
  );
}
