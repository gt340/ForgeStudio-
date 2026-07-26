export default function TermsOfService() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "60px 24px", lineHeight: 1.7 }}>
      <h1>Terms of Service</h1>
      <p><em>Last updated: {new Date().toLocaleDateString()}</em></p>

      <h2>Using ForgeStudio</h2>
      <p>ForgeStudio lets you generate websites and apps from text prompts, manage environment variables, build installable Android app packages, and connect third-party integrations. By using ForgeStudio, you agree to these terms.</p>

      <h2>Your content</h2>
      <p>You retain ownership of the prompts you submit and the sites/apps generated for you. You're responsible for making sure your prompts and generated content don't violate any laws or third-party rights.</p>

      <h2>Third-party integrations</h2>
      <p>Connecting a third-party service (Stripe, Supabase, Slack, GitHub, Google Business Profile, etc.) is optional and requires your explicit authorization. Your use of those services is also subject to their own terms. You can disconnect at any time.</p>

      <h2>App builds</h2>
      <p>Android app packages generated through ForgeStudio are built on your behalf using your submitted content. You are responsible for complying with any app store policies if you choose to distribute a build.</p>

      <h2>No warranty</h2>
      <p>ForgeStudio is provided as-is. We do our best to keep the service reliable but don't guarantee uninterrupted availability.</p>

      <h2>Contact</h2>
      <p>Questions about these terms can be sent to ForgeStudio@gmail.com. For business inquiries, contact trustGodcompany@gmail.com.</p>
    </main>
  );
}
