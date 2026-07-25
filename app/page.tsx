import LivePreview from '@/components/LivePreview';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#05070d] text-white px-6 py-20">
      <h1 className="text-4xl font-bold mb-8">ForgeStudio — live demo</h1>
      <LivePreview />
    </main>
  );
}
