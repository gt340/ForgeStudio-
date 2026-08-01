import LivePreview from '@/components/LivePreview';
import EnvVarsPanel from '@/components/EnvVarsPanel';
import IntegrationsCanvas from '@/components/IntegrationsCanvas';
import SeoPanel from '@/components/SeoPanel';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#05070d] text-white px-6 py-20 space-y-12">
      <h1 className="text-4xl font-bold">ForgeStudio — live demo</h1>
      <p className="text-white/70 max-w-2xl mb-8">ForgeStudio is an AI-powered website and app builder. Describe the business or site you want in plain language, and ForgeStudio generates a working website with a live preview, lets you connect integrations like Stripe and Supabase, and package it as an installable Android app.</p>
      <LivePreview />
      <EnvVarsPanel />
      <IntegrationsCanvas />
        <SeoPanel />
    </main>
  );
}
