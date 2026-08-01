'use client';
import { useState } from 'react';

function stripFences(text: string) {
  return text
    .replace(/^```(jsx|tsx|js|javascript|typescript)?\n?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function buildSandboxFiles(componentCode: string) {
  return {
    'package.json': JSON.stringify(
      {
        name: 'forgestudio-preview',
        private: true,
        scripts: { dev: 'next dev' },
        dependencies: {
          next: '14.2.5',
          react: '18.3.1',
          'react-dom': '18.3.1',
        },
      },
      null,
      2
    ),
    'next.config.js': 'module.exports = {};',
    'app/layout.tsx':
      'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
      '  return (\n' +
      '    <html lang="en">\n' +
      '      <body>{children}</body>\n' +
      '    </html>\n' +
      '  );\n' +
      '}\n',
    'app/page.tsx': componentCode,
  };
}

export default function LivePreview() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating' | 'booting' | 'ready' | 'error'>('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  async function pollStatus(sandboxId: string) {
    const maxAttempts = 40; // ~2 minutes at 3s intervals
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/sandbox/status?id=${sandboxId}`);
        const data = await res.json();
        if (data.ready && data.url) {
          setPreviewUrl(data.url);
          setStatus('ready');
          return;
        }
      } catch (e) {
        console.error(e);
      }
    }
    setStatus('error');
  }

  async function handleGenerate(usePrompt?: string) {
    const p = usePrompt ?? prompt;
    if (!p) return;
    setLoading(true);
    setLastPrompt(p);
    setStatus('generating');
    setPreviewUrl(null);

    try {
      const genRes = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: p }),
      });
      const genData = await genRes.json();
      const code = stripFences(genData.code);

      setStatus('booting');
      const files = function buildSandboxFiles(componentCode: string) {
  return {
    'package.json': JSON.stringify(
      {
        name: 'forgestudio-preview',
        private: true,
        scripts: { dev: 'next dev' },
        dependencies: {
          next: '14.2.5',
          react: '18.3.1',
          'react-dom': '18.3.1',
        },
      },
      null,
      2
    ),
    'next.config.js': 'module.exports = {};',
    'app/layout.js':
      'export default function RootLayout({ children }) {\n' +
      '  return (\n' +
      '    <html lang="en">\n' +
      '      <body>{children}</body>\n' +
      '    </html>\n' +
      '  );\n' +
      '}\n',
    'app/page.js': componentCode,
  };
      }

      const createRes = await fetch('/api/sandbox/create', {
        method: 'POST',
        body: JSON.stringify({ files }),
      });
      const createData = await createRes.json();

      if (!createData.sandboxId) {
        setStatus('error');
        setLoading(false);
        return;
      }

      await pollStatus(createData.sandboxId);
    } catch (e) {
      console.error(e);
      setStatus('error');
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
          onClick={() => handleGenerate()}
          disabled={loading}
          className="rounded-lg bg-cyan-400 text-black px-5 py-2 text-sm font-semibold"
        >
          {loading ? 'Forging...' : 'Generate'}
        </button>
        {lastPrompt && (
          <button
            onClick={() => handleGenerate(lastPrompt)}
            disabled={loading}
            className="rounded-lg bg-white/10 text-white px-5 py-2 text-sm font-semibold border border-white/20"
          >
            Regenerate
          </button>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-black/40 h-[480px] flex items-center justify-center overflow-hidden">
        {status === 'idle' && (
          <p className="text-white/40 text-sm">Describe a site above to generate it.</p>
        )}
        {status === 'generating' && (
          <p className="text-white/60 text-sm">Generating code...</p>
        )}
        {status === 'booting' && (
          <p className="text-white/60 text-sm">Booting live sandbox... this can take up to a minute.</p>
        )}
        {status === 'error' && (
          <p className="text-red-400 text-sm">Something went wrong. Try Regenerate.</p>
        )}
        {status === 'ready' && previewUrl && (
          <iframe src={previewUrl} className="w-full h-full" title="Live preview" />
        )}
      </div>
    </div>
  );
          }
