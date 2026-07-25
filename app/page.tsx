import LivePreview from '@/components/LivePreview';
import EnvVarsPanel from '@/components/EnvVarsPanel';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#05070d] text-white px-6 py-20 space-y-12">
      <h1 className="text-4xl font-bold">ForgeStudio — live demo</h1>
      <LivePreview />
      <EnvVarsPanel />
    </main>
  );
}
