export default function EulaPage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "60px 20px", color: "#e6e6e6" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: 16 }}>End User License Agreement</h1>
      <p style={{ marginBottom: 16, opacity: 0.7 }}>Last updated: August 2026</p>

      <p style={{ marginBottom: 16 }}>
        This End User License Agreement ("Agreement") governs your use of ForgeStudio
        ("the Service"), including its Vercel integration. By using the Service, you
        agree to the terms below.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>1. License</h2>
      <p style={{ marginBottom: 16 }}>
        ForgeStudio grants you a limited, non-exclusive, non-transferable license to
        access and use the Service for the purpose of generating, previewing, and
        deploying applications.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>2. Your content</h2>
      <p style={{ marginBottom: 16 }}>
        Code and applications you generate using ForgeStudio belong to you. ForgeStudio
        does not claim ownership over the output you create.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>3. Third-party integrations</h2>
      <p style={{ marginBottom: 16 }}>
        When you connect a third-party service (such as Vercel, GitHub, or Slack) to
        ForgeStudio, you authorize ForgeStudio to act on your behalf within the scopes
        you approve, for example to create deployments or push code, until you
        disconnect that integration.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>4. No warranty</h2>
      <p style={{ marginBottom: 16 }}>
        The Service is provided "as is" without warranties of any kind. ForgeStudio is
        not liable for any damages arising from your use of the Service or any
        generated code.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>5. Termination</h2>
      <p style={{ marginBottom: 16 }}>
        You may stop using the Service and disconnect any integration at any time.
        ForgeStudio may suspend access for violations of this Agreement.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>6. Contact</h2>
      <p style={{ marginBottom: 16 }}>
        Questions about this Agreement? Email{" "}
        <a href="mailto:ForgeStudio@gmail.com" style={{ color: "#4dd0e1" }}>
          ForgeStudio@gmail.com
        </a>.
      </p>
    </div>
  );
        }
