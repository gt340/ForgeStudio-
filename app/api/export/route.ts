import JSZip from 'jszip';

export async function POST(req: Request) {
  const { code } = await req.json();

  if (!code) {
    return Response.json({ error: 'Missing code' }, { status: 400 });
  }

  const zip = new JSZip();

  zip.file(
    'package.json',
    JSON.stringify(
      {
        name: 'forgestudio-export',
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: {
          next: '14.2.32',
          react: '18.3.1',
          'react-dom': '18.3.1',
        },
      },
      null,
      2
    )
  );

  zip.file('next.config.js', 'module.exports = {};\n');

  zip.file(
    'app/layout.js',
    'export default function RootLayout({ children }) {\n' +
      '  return (\n' +
      '    <html lang="en">\n' +
      '      <body>{children}</body>\n' +
      '    </html>\n' +
      '  );\n' +
      '}\n'
  );

  zip.file('app/page.js', code);

  zip.file(
    'README.md',
    '# ForgeStudio Export\n\nRun locally:\n\n```\nnpm install\nnpm run dev\n```\n'
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="forgestudio-export.zip"',
    },
  });
           }
