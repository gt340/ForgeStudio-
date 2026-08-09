'use client';
import { useState, useEffect } from 'react';

function stripFences(text: string) {
  return text
    .replace(/^```(jsx|tsx|js|javascript|typescript)?\n?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function fetchJSON(url: string, options: RequestInit, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Request failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`The AI took too long to respond (over ${Math.round(timeoutMs / 1000)}s). Please try again.`);
    }
    if (e instanceof TypeError) {
      throw new Error('Network issue — please check your connection and try again.');
    }
    throw e;
  }
}

async function resolveImagePlaceholders(code: string): Promise<string> {
  const pattern = /\{\{(IMG|VIDEO):([^}]+)\}\}/g;
  const matches = [...code.matchAll(pattern)];
  if (matches.length === 0) return code;

  const uniqueMatches = Array.from(new Map(matches.map((m) => [m[0], m])).values());

  const resolved = await Promise.all(
    uniqueMatches.map(async ([fullMatch, kind, query]) => {
      try {
        const data = await fetchJSON('/api/images/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: query.trim(),
            type: kind === 'VIDEO' ? 'video' : 'photo',
          }),
        }, 20000);
        return [fullMatch, data.url || 'https://via.placeholder.com/1200x800?text=Image'] as const;
      } catch (e) {
        console.error('Image resolve failed:', e);
        return [fullMatch, 'https://via.placeholder.com/1200x800?text=Image'] as const;
      }
    })
  );

  let result = code;
  for (const [fullMatch, url] of resolved) {
    result = result.split(fullMatch).join(url);
  }
  return result;
}

async function buildSandboxFiles(componentCode: string) {
  const resolvedCode = await resolveImagePlaceholders(componentCode);

  const clientCode = resolvedCode.trimStart().startsWith("'use client'")
    ? resolvedCode
    : `'use client';\n${resolvedCode}`;

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
          '@supabase/supabase-js': '2.45.4',
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
    'app/page.js': clientCode,
  };
}

type PollResult = { ready: true; url: string } | { ready: false; log: string };
type Suggestion = { id: string; label: string; description: string; needsBackend: boolean };
type SavedProject = {
  id: string;
  created_at: string;
  prompt: string;
  code: string;
  preview_url: string | null;
  sandbox_id: string | null;
};

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 25; // 25 x 2s = 50s per cycle
const MAX_REPAIR_ATTEMPTS = 1;

function withCacheBuster(url: string) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_r=${Date.now()}`;
}

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
  const [repoName, setRepoName] = useState('');
  const [githubStatus, setGithubStatus] = useState<'idle' | 'pushing' | 'done' | 'error'>('idle');
  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [repairAttempt, setRepairAttempt] = useState(0);
  const [lastRepairCount, setLastRepairCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const [suggestionStatus, setSuggestionStatus] = useState<Record<string, 'idle' | 'applying' | 'done' | 'error'>>({});
  const [suggestionError, setSuggestionError] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [historyProjects, setHistoryProjects] = useState<SavedProject[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  useEffect(() => {
    const busyStates = ['generating', 'booting', 'editing', 'repairing'];
    if (busyStates.includes(status)) {
      setElapsedSeconds(0);
      const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
      return () => clearInterval(id);
    }
  }, [status]);

  async function pollStatus(sbId: string): Promise<PollResult> {
    let lastLog = '';
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`/api/sandbox/status?id=${sbId}`, { signal: controller.signal });
        clearTimeout(timer);
        const data = await res.json();
        if (data.log) lastLog = data.log;
        if (data.ready && data.url) {
          return { ready: true, url: data.url };
        }
      } catch (e) {
        console.error('Status check timed out or failed, retrying:', e);
      }
    }
    return { ready: false, log: lastLog };
  }

  async function resolveBuild(
    sbId: string,
    currentCode: string,
    originalPrompt: string,
    attempt = 0,
    onSuccess?: (url: string, finalCode: string) => void
  ): Promise<boolean> {
    const result = await pollStatus(sbId);

    if (result.ready) {
      const freshUrl = withCacheBuster(result.url);
      setPreviewUrl(freshUrl);
      setStatus('ready');
      setLastRepairCount(attempt);
      if (onSuccess) onSuccess(result.url, currentCode);
      return true;
    }

    if (attempt < MAX_REPAIR_ATTEMPTS) {
      setStatus('repairing');
      setRepairAttempt(attempt + 1);
      try {
        const repairData = await fetchJSON('/api/generate', {
          method: 'POST',
          body: JSON.stringify({
            prompt: originalPrompt,
            existingCode: currentCode,
            errorLog: result.log,
          }),
        });
        const fixedCode = stripFences(repairData.code);
        setCode(fixedCode);

        const files = await buildSandboxFiles(fixedCode);
        await fetch('/api/sandbox/update', {
          method: 'POST',
          body: JSON.stringify({ sandboxId: sbId, files }),
        });

        return resolveBuild(sbId, fixedCode, originalPrompt, attempt + 1, onSuccess);
      } catch (e: any) {
        console.error(e);
        setDebugLog(e?.message || 'Repair attempt failed');
        setStatus('error');
        return false;
      }
    }

    setDebugLog(result.log || 'Build did not finish in time after a repair attempt.');
    setStatus('error');
    return false;
  }

  async function fetchSuggestions(p: string) {
    try {
      const data = await fetchJSON('/api/suggestions', {
        method: 'POST',
        body: JSON.stringify({ prompt: p }),
      }, 30000);
      setSuggestions(data.suggestions || []);
    } catch (e) {
      console.error('Failed to fetch suggestions:', e);
    }
  }

  async function saveProject(p: string, c: string, url: string, sbId: string) {
    setSaveStatus('saving');
    setSaveError('');
    try {
      const data = await fetchJSON('/api/projects/save', {
        method: 'POST',
        body: JSON.stringify({ prompt: p, code: c, previewUrl: url, sandboxId: sbId }),
      }, 20000);
      setSaveStatus('saved');
      if (data?.project?.id) setCurrentProjectId(data.project.id);
    } catch (e: any) {
      console.error('Failed to save project history:', e);
      setSaveStatus('error');
      setSaveError(e?.message || 'Unknown error saving to history');
    }
  }

  async function updateProjectSnapshot(c: string, url: string) {
    if (!currentProjectId) return;
    try {
      await fetchJSON('/api/projects/update', {
        method: 'POST',
        body: JSON.stringify({ id: currentProjectId, code: c, previewUrl: url }),
      }, 20000);
    } catch (e) {
      console.error('Failed to update saved project snapshot:', e);
    }
  }

  async function fetchHistory() {
    setHistoryLoading(true);
    try {
      const data = await fetchJSON('/api/projects/list', { method: 'GET' }, 20000);
      setHistoryProjects(data.projects || []);
    } catch (e) {
      console.error('Failed to load history:', e);
    }
    setHistoryLoading(false);
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) fetchHistory();
  }

  async function openProject(p: SavedProject) {
    setShowHistory(false);
    setLoading(true);
    setPrompt(p.prompt);
    setLastPrompt(p.prompt);
    setCode(p.code);
    setStatus('booting');
    setPreviewUrl(null);
    setDebugLog('');
    setSandboxId(null);
    setGithubStatus('idle');
    setGithubUrl(null);
    setRepairAttempt(0);
    setLastRepairCount(0);
    setSuggestions([]);
    setExpandedSuggestion(null);
    setSuggestionStatus({});
    setSuggestionError({});
    setSaveStatus('idle');
    setSaveError('');
    setCurrentProjectId(p.id);

    try {
      const files = await buildSandboxFiles(p.code);
      const createRes = await fetch('/api/sandbox/create', {
        method: 'POST',
        body: JSON.stringify({ files }),
      });
      const createData = await createRes.json();

      if (!createData.sandboxId) {
        setDebugLog('Could not relaunch this saved project.');
        setStatus('error');
        setLoading(false);
        return;
      }
      setSandboxId(createData.sandboxId);
      await resolveBuild(createData.sandboxId, p.code, p.prompt);
      fetchSuggestions(p.prompt);
    } catch (e: any) {
      console.error(e);
      setDebugLog(e?.message || 'Failed to reopen this project');
      setStatus('error');
    }
    setLoading(false);
  }

  async function applySuggestion(s: Suggestion) {
    if (!code || !sandboxId) return;
    setExpandedSuggestion(null);
    setSuggestionStatus((prev) => ({ ...prev, [s.id]: 'applying' }));
    setSuggestionError((prev) => ({ ...prev, [s.id]: '' }));

    const instruction = `Add this feature to the website: ${s.label} — ${s.description}`;

    try {
      const genData = await fetchJSON('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: instruction, existingCode: code }),
      });
      const newCode = stripFences(genData.code);
      setCode(newCode);

      const files = await buildSandboxFiles(newCode);
      await fetch('/api/sandbox/update', {
        method: 'POST',
        body: JSON.stringify({ sandboxId, files }),
      });

      const success = await resolveBuild(sandboxId, newCode, instruction, 0, (url, finalCode) => {
        updateProjectSnapshot(finalCode, url);
      });
      setSuggestionStatus((prev) => ({ ...prev, [s.id]: success ? 'done' : 'error' }));
      if (!success) {
        setSuggestionError((prev) => ({ ...prev, [s.id]: debugLog || 'Build failed after adding this feature.' }));
      }
    } catch (e: any) {
      console.error(e);
      setSuggestionStatus((prev) => ({ ...prev, [s.id]: 'error' }));
      setSuggestionError((prev) => ({ ...prev, [s.id]: e?.message || 'Something went wrong.' }));
    }
  }

  async function applyConnectedSuggestion(s: Suggestion) {
    if (!code || !sandboxId) return;
    setExpandedSuggestion(null);
    setSuggestionStatus((prev) => ({ ...prev, [s.id]: 'applying' }));
    setSuggestionError((prev) => ({ ...prev, [s.id]: '' }));

    try {
      const setupData = await fetchJSON('/api/supabase/setup-table', { method: 'POST' }, 60000);

      if (setupData.error || !setupData.projectUrl || !setupData.anonKey) {
        console.error('Supabase setup failed:', setupData.error);
        setSuggestionStatus((prev) => ({ ...prev, [s.id]: 'error' }));
        setSuggestionError((prev) => ({ ...prev, [s.id]: setupData.error || 'Could not set up Supabase table.' }));
        return;
      }

      const instruction = `Add this feature to the website: ${s.label} — ${s.description}

Wire it to a real database using supabase-js, already installed. Use exactly this setup:
import { createClient } from '@supabase/supabase-js';
const supabase = createClient('${setupData.projectUrl}', '${setupData.anonKey}');

On form submit, call e.preventDefault(), then insert one row into the table '${setupData.tableName}' with columns: source (set to a short string describing this feature, e.g. newsletter or contact or booking), name, email, phone, message (use empty string for any field not collected by this form). After a successful insert, show a confirmation message using component state, like Thanks we will be in touch. If the insert fails, show a simple error message instead.`;

      const genData = await fetchJSON('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: instruction, existingCode: code }),
      });
      const newCode = stripFences(genData.code);
      setCode(newCode);

      const files = await buildSandboxFiles(newCode);
      await fetch('/api/sandbox/update', {
        method: 'POST',
        body: JSON.stringify({ sandboxId, files }),
      });

      const success = await resolveBuild(sandboxId, newCode, instruction, 0, (url, finalCode) => {
        updateProjectSnapshot(finalCode, url);
      });
      setSuggestionStatus((prev) => ({ ...prev, [s.id]: success ? 'done' : 'error' }));
      if (!success) {
        setSuggestionError((prev) => ({ ...prev, [s.id]: debugLog || 'Build failed after connecting this feature.' }));
      }
    } catch (e: any) {
      console.error(e);
      setSuggestionStatus((prev) => ({ ...prev, [s.id]: 'error' }));
      setSuggestionError((prev) => ({ ...prev, [s.id]: e?.message || 'Something went wrong.' }));
    }
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
    setGithubStatus('idle');
    setGithubUrl(null);
    setRepairAttempt(0);
    setLastRepairCount(0);
    setSuggestions([]);
    setExpandedSuggestion(null);
    setSuggestionStatus({});
    setSuggestionError({});
    setSaveStatus('idle');
    setSaveError('');
    setCurrentProjectId(null);

    try {
      const genData = await fetchJSON('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: p }),
      });
      const newCode = stripFences(genData.code);
      setCode(newCode);

      setStatus('booting');
      const files = await buildSandboxFiles(newCode);

      const createRes = await fetch('/api/sandbox/create', {
        method: 'POST',
        body: JSON.stringify({ files }),
      });
      const createData = await createRes.json();

      if (!createData.sandboxId) {
        setDebugLog('Sandbox creation failed');
        setStatus('error');
        setLoading(false);
        return;
      }
      setSandboxId(createData.sandboxId);

      await resolveBuild(createData.sandboxId, newCode, p, 0, (url, finalCode) => {
        saveProject(p, finalCode, url, createData.sandboxId);
      });
      fetchSuggestions(p);
    } catch (e: any) {
      console.error(e);
      setDebugLog(e?.message || 'Generation failed');
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
    setRepairAttempt(0);
    setLastRepairCount(0);

    try {
      const genData = await fetchJSON('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: instruction, existingCode: code }),
      });
      const newCode = stripFences(genData.code);
      setCode(newCode);

      const files = await buildSandboxFiles(newCode);
      await fetch('/api/sandbox/update', {
        method: 'POST',
        body: JSON.stringify({ sandboxId, files }),
      });

      setEditPrompt('');
      await resolveBuild(sandboxId, newCode, instruction, 0, (url, finalCode) => {
        updateProjectSnapshot(finalCode, url);
      });
    } catch (e: any) {
      console.error(e);
      setDebugLog(e?.message || 'Edit failed');
      setStatus('error');
    }
    setLoading(false);
  }

  const idle = status === 'idle' && !previewUrl;
  const busy = loading || status === 'generating' || status === 'booting' || status === 'editing' || status === 'repairing';

  return (
    <div className="space-y-6">
      <div className="flex justify-end max-w-2xl mx-auto w-full">
        <button
          onClick={toggleHistory}
          className="text-xs text-white/50 hover:text-cyan-300 underline underline-offset-2 transition-colors"
        >
          {showHistory ? 'Close history' : 'History'}
        </button>
      </div>

      {showHistory && (
        <div className="max-w-2xl mx-auto w-full space-y-2 rounded-2xl border border-white/10 bg-black/40 p-4">
          <h2 className="text-sm font-semibold text-white/80">Your saved projects</h2>
          {historyLoading && <p className="text-xs text-white/40">Loading…</p>}
          {!historyLoading && historyProjects.length === 0 && (
            <p className="text-xs text-white/40">No saved projects yet — build something and it will show up here.</p>
          )}
          <div className="space-y-2">
            {historyProjects.map((p) => (
              <button
                key={p.id}
                onClick={() => openProject(p)}
                className="w-full text-left rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-3 py-2 transition-colors"
              >
                <p className="text-sm text-white/90 truncate">{p.prompt}</p>
                <p className="text-xs text-white/40">{new Date(p.created_at).toLocaleString()}</p>
              </button>
            ))}
          </div>
        </div>
      )}

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
          <p className="text-white/60 text-sm animate-pulse">
            Generating code… ({elapsedSeconds}s)
          </p>
        )}
        {status === 'booting' && (
          <p className="text-white/60 text-sm animate-pulse">
            Booting live sandbox… ({elapsedSeconds}s, can take up to a minute)
          </p>
        )}
        {status === 'editing' && (
          <p className="text-white/60 text-sm animate-pulse">
            Applying your edit… ({elapsedSeconds}s)
          </p>
        )}
        {status === 'repairing' && (
          <p className="text-white/60 text-sm animate-pulse">
            Something broke — the AI is fixing it automatically… (attempt {repairAttempt} of {MAX_REPAIR_ATTEMPTS}, {elapsedSeconds}s)
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

      {status === 'ready' && lastRepairCount > 0 && (
        <div className="text-center -mt-3">
          <span className="text-xs text-cyan-300/80">
            ✓ Auto-fixed {lastRepairCount} {lastRepairCount === 1 ? 'issue' : 'issues'} automatically
          </span>
        </div>
      )}

      {status === 'ready' && saveStatus === 'saving' && (
        <div className="text-center -mt-3">
          <span className="text-xs text-white/40">Saving to history…</span>
        </div>
      )}
      {status === 'ready' && saveStatus === 'saved' && (
        <div className="text-center -mt-3">
          <span className="text-xs text-cyan-300/80">✓ Saved to history</span>
        </div>
      )}
      {status === 'ready' && saveStatus === 'error' && (
        <div className="text-center -mt-3">
          <span className="text-xs text-red-400">⚠ Could not save to history: {saveError}</span>
        </div>
      )}

      {status === 'ready' && suggestions.length > 0 && (
        <div className="max-w-2xl mx-auto w-full space-y-3">
          <p className="text-xs text-white/40 text-center">Want to make this even more professional?</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {suggestions.map((s) => (
              <div key={s.id} className="flex flex-col items-center">
                <button
                  onClick={() => setExpandedSuggestion(expandedSuggestion === s.id ? null : s.id)}
                  disabled={suggestionStatus[s.id] === 'applying'}
                  className="text-xs rounded-full border border-cyan-400/30 bg-white/5 hover:bg-white/10 text-white/80 px-3 py-1.5 transition-colors disabled:opacity-50"
                >
                  {suggestionStatus[s.id] === 'applying'
                    ? 'Adding…'
                    : suggestionStatus[s.id] === 'done'
                    ? `✓ ${s.label}`
                    : suggestionStatus[s.id] === 'error'
                    ? `⚠ ${s.label}`
                    : `+ ${s.label}`}
                </button>
                {expandedSuggestion === s.id && (
                  <div className="mt-2 w-64 text-xs text-white/60 bg-black/40 border border-white/10 rounded-lg p-3 space-y-2 text-left">
                    <p>{s.description}</p>
                    <p className="text-white/40">
                      <span className="text-cyan-300 font-medium">Quick add:</span> adds this to your page right now.
                    </p>
                    {s.needsBackend && (
                      <p className="text-white/40">
                        <span className="text-orange-300 font-medium">Connected:</span> saves real submissions using your connected Supabase database.
                      </p>
                    )}
                    <div className="flex flex-col gap-1.5 pt-1">
                      <button
                        onClick={() => applySuggestion(s)}
                        className="w-full rounded-lg px-3 py-1.5 text-xs font-semibold text-black transition-all"
                        style={{ background: 'linear-gradient(90deg, #00e5ff, #ff6b35)' }}
                      >
                        Quick add
                      </button>
                      {s.needsBackend && (
                        <button
                          onClick={() => applyConnectedSuggestion(s)}
                          className="w-full rounded-lg px-3 py-1.5 text-xs font-semibold text-white border border-orange-400/40 hover:bg-orange-400/10 transition-all"
                        >
                          Connect & add
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {expandedSuggestion !== s.id && suggestionStatus[s.id] === 'error' && suggestionError[s.id] && (
                  <button
                    onClick={() => setExpandedSuggestion(s.id)}
                    className="mt-1 text-[10px] text-red-400 underline"
                  >
                    See error
                  </button>
                )}
                {expandedSuggestion === s.id && suggestionStatus[s.id] === 'error' && suggestionError[s.id] && (
                  <div className="mt-1 w-64 text-[10px] text-red-400 bg-black/40 border border-red-400/20 rounded-lg p-2 text-left whitespace-pre-wrap font-mono">
                    {suggestionError[s.id]}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-center mt-3">
        <button
          onClick={async () => {
            if (!code) return;
            const res = await fetch('/api/export', {
              method: 'POST',
              body: JSON.stringify({ code }),
            });
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'forgestudio-export.zip';
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="text-xs text-white/50 hover:text-cyan-300 underline underline-offset-2 transition-colors"
        >
          Export as ZIP
        </button>
      </div>

      {status === 'ready' && previewUrl && (
        <div className="flex flex-col items-center gap-2 mt-3">
          <input
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="repo-name"
            className="text-xs bg-black/30 border border-white/10 rounded px-3 py-1.5 text-white/80 placeholder:text-white/30 focus:outline-none focus:border-cyan-400/40"
          />
          <button
            onClick={async () => {
              if (!code || !repoName) return;
              setGithubStatus('pushing');
              try {
                const res = await fetch('/api/deploy/github', {
                  method: 'POST',
                  body: JSON.stringify({ code, repoName }),
                });
                const data = await res.json();
                if (data.url) {
                  setGithubUrl(data.url);
                  setGithubStatus('done');
                } else {
                  setGithubStatus('error');
                }
              } catch (e) {
                console.error(e);
                setGithubStatus('error');
              }
            }}
            disabled={!repoName || githubStatus === 'pushing'}
            className="text-xs text-white/50 hover:text-cyan-300 underline underline-offset-2 transition-colors disabled:opacity-40"
          >
            {githubStatus === 'pushing' ? 'Pushing to GitHub…' : 'Push to GitHub'}
          </button>
          {githubStatus === 'done' && githubUrl && (
            <a href={githubUrl} target="_blank" rel="noreferrer" className="text-xs text-cyan-300 underline">
              View repo →
            </a>
          )}
          {githubStatus === 'error' && (
            <p className="text-xs text-red-400">Push failed — is GitHub connected?</p>
          )}
        </div>
      )}

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
