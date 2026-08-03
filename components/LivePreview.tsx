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
          next: '14.2.32',
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

type PollResult = { ready: true; url: string } | { ready: false; log: string };

export default function LivePreview() {
  const [prompt, setPrompt] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'idle' | 'generating' | 'booting' | 'editing' | 'repairing' | 'ready' | 'error'
  >('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState('');

  async function pollStatus(sbId: string): Promise<PollResult> {
    const maxAttempts = 40;
    let lastLog = '';
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`/api/sandbox/status?id=${sbId}`);
        const data = await res.json();
        if (data.log) lastLog = data.log;
        if (data.ready && data.url) {
          return { ready: true, url: data.url };
        }
      } catch (e) {
        console.error(e);
      }
    }
    return { ready: false, log: lastLog };
  }

  async function resolveBuild(
    sbId: string,
    currentCode: string,
    originalPrompt: string,
    attempt = 0
  ) {
    const result = await pollStatus(sbId);

    if (result.ready) {
      setPreviewUrl(result.url);
      setStatus('ready');
      return;
    }

    if (attempt < 2) {
      setStatus('repairing');
      try {
        const repairRes = await fetch('/api/generate', {
          method: 'POST',
          body: JSON.stringify({
            prompt: originalPrompt,
            existingCode: currentCode,
            errorLog: result.log,
          }),
        });
        const repairData = await repairRes.json();
        const fixedCode = stripFences(repairData.code);
        setCode(fixedCode);

        const files = buildSandboxFiles(fixedCode);
        await fetch('/api/sandbox/update', {
          method: 'POST',
          body: JSON.stringify({ sandboxId: sbId, files }),
        });

        return resolveBuild(sbId, fixedCode, originalPrompt, attempt + 1);
      } catch (e) {
        console.error(e);
      }
    }

    setDebugLog(result.log);
    setStatus('error');
  }

  async function handleGenerate(usePrompt?: string) {
    const p = usePrompt ?? prompt;
    if (!p) return;
    setLoading(true);
    setLastPrompt(p);
    setStatus('generating');
    setPreviewUrl(null);
    setDebugLog('');
    setSandboxId(null);

    try {
      const genRes = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: p }),
      });
      const genData = await genRes.json();
      const newCode = stripFences(genData.code);
      setCode(newCode);

      setStatus('booting');
      const files = buildSandboxFiles(newCode);

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
      setSandboxId(createData.sandboxId);

      await resolveBuild(createData.sandboxId, newCode, p);
    } catch (e) {
      console.error(e);
      setStatus('error');
    }
    setLoading(false);
  }

  async function handleEdit() {
    const instruction = editPrompt;
    if (!instruction || !sandboxId || !code) return;
    setLoading(true);
    setStatus('editing');
    setDebugLog('');

    try {
      const genRes = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: instruction, existingCode: code }),
      });
      const genData = await genRes.json();
      const newCode = stripFences(genData.code);
      setCode(newCode);

      const files = buildSandboxFiles(newCode);
      await fetch('/api/sandbox/update', {
        method: 'POST',
        body: JSON.stringify({ sandboxId, files }),
      });

      setEditPrompt('');
      await resolveBuild(sandboxId, newCode, instruction);
    } catch (e) {
      console.error(e);
      setStatus('error');
    }
    setLoading(false);
  }

  const idle = status === 'idle' && !previewUrl;
  const busy = loading || status === 'generating' || status === 'booting' || status === 'editing' || status === 'repairing';

  return (
    <div className="space-y-6">
      {idle && (
        <div className="text-center pt-10 pb-2">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Let&apos;s build something
          </h1>
        </div>
      )}

      <div className="max-w-2xl mx-auto w-full">
        <div
          className="rounded-2xl border border-cyan-400/20 focus-within:border-cyan-400/50 bg-white/[0.03] backdrop-blur-sm p-3 transition-colors"
          style={{ boxShadow: '0 0 30px rgba(0,229,255,0.06)' }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Build a landing page for my..."
            rows={2}
            className="w-full bg-transparent resize-none px-2 py-1.5 text-sm placeholder:text-white/30 focus:outline-none"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-xs text-white/30">
              {lastPrompt ? 'Starts a brand new build' : 'Describe the site you want'}
            </span>
            <div className="flex items-center gap-2">
              {lastPrompt && (
                <button
                  onClick={() => handleGenerate(lastPrompt)}
                  disabled={busy}
                  className="rounded-lg bg-white/5 hover:bg-white/10 text-white/80 px-4 py-2 text-sm font-medium border border-white/10 transition-colors disabled:opacity-50"
                >
                  Regenerate
                </button>
              )}
              <button
                onClick={() => handleGenerate()}
                disabled={busy}
                className="rounded-lg px-5 py-2 text-sm font-semibold text-black transition-all disabled:opacity-50"
                style={{
                  background: 'linear-gradient(90deg, #00e5ff, #ff6b35)',
                  boxShadow: '0 0 16px rgba(0,229,255,0.3)',
                }}
              >
                {status === 'generating' ? 'Generating…' : status === 'booting' ? 'Booting…' : 'Build'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/40 min-h-[480px] flex items-center justify-center text-center p-6 overflow-hidden">
        {status === 'idle' && (
          <p className="text-white/40 text-sm">Describe a site above to generate it.</p>
        )}
        {status === 'generating' && (
          <p className="text-white/60 text-sm animate-pulse">Generating code…</p>
        )}
        {status === 'booting' && (
          <p className="text-white/60 text-sm animate-pulse">
            Booting live sandbox… this can take up to a minute.
          </p>
        )}
        {status === 'editing' && (
          <p className="text-white/60 text-sm animate-pulse">Applying your edit…</p>
        )}
        {status === 'repairing' && (
          <p className="text-white/60 text-sm animate-pulse">
            Something broke — the AI is fixing it automatically…
          </p>
        )}
        {status === 'error' && (
          <div className="text-left text-xs text-red-400 p-4 overflow-auto max-h-[480px] w-full whitespace-pre-wrap font-mono">
            <p className="mb-2 font-semibold">Something went wrong. Try Regenerate.</p>
            {debugLog && <pre>{debugLog}</pre>}
          </div>
        )}
        {status === 'ready' && previewUrl && (
          <iframe src={previewUrl} className="w-full h-full" title="Live preview" />
        )}
      </div>

      {status === 'ready' && previewUrl && (
        <div className="max-w-2xl mx-auto w-full">
          <div className="rounded-2xl border border-orange-400/20 focus-within:border-orange-400/50 bg-white/[0.03] backdrop-blur-sm p-3 transition-colors">
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              placeholder="Make the button blue, add a contact form..."
              rows={2}
              className="w-full bg-transparent resize-none px-2 py-1.5 text-sm placeholder:text-white/30 focus:outline-none"
            />
            <div className="flex items-center justify-between px-1 pt-1">
              <span className="text-xs text-white/30">Edits apply to the live sandbox</span>
              <button
                onClick={handleEdit}
                disabled={busy || !editPrompt}
                className="rounded-lg px-5 py-2 text-sm font-semibold text-black transition-all disabled:opacity-50"
                style={{
                  background: 'linear-gradient(90deg, #ff6b35, #00e5ff)',
                  boxShadow: '0 0 16px rgba(255,107,53,0.25)',
                }}
              >
                Apply Edit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
