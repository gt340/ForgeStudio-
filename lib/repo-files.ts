// Single source of truth for the files of a generated site's repository.
// Used by BOTH the GitHub sync (app/api/deploy/github/route.ts) and the ZIP export (app/api/export/route.ts)
// so the two can never drift apart again. A generated site is ONE Next.js page component; it is written to
// app/page.js and must be the *prepared* code (see lib/deploy-code.ts: 'use client' ensured, {{IMG}}/{{VIDEO}}
// placeholders resolved) — a page that uses React hooks and lacks 'use client' cannot be built by Next.js.

import { prepareDeployableCode } from '@/lib/deploy-code';

/** Pinned runtime dependencies of every generated site (kept identical for GitHub/Vercel and the ZIP export). */
export const SITE_DEPENDENCIES: Record<string, string> = {
  next: '14.2.32',
  react: '18.3.1',
  'react-dom': '18.3.1',
  '@supabase/supabase-js': '2.45.4',
};

export type RepoFilesOptions = {
  /** package.json "name" */
  name: string;
  /** README.md content */
  readme: string;
};

/** Builds the repository file map from code that has ALREADY been prepared (use buildDeployableRepoFiles otherwise). */
export function buildRepoFiles(preparedCode: string, opts: RepoFilesOptions): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      {
        name: opts.name,
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { ...SITE_DEPENDENCIES },
      },
      null,
      2
    ),
    'next.config.js': 'module.exports = {};\n',
    'app/layout.js':
      'export default function RootLayout({ children }) {\n' +
      '  return (\n' +
      '    <html lang="en">\n' +
      '      <body>{children}</body>\n' +
      '    </html>\n' +
      '  );\n' +
      '}\n',
    'app/page.js': preparedCode,
    'README.md': opts.readme,
  };
}

/** Prepares the saved source (directive + media placeholders) and builds the repository files from it. */
export async function buildDeployableRepoFiles(code: string, opts: RepoFilesOptions): Promise<Record<string, string>> {
  return buildRepoFiles(await prepareDeployableCode(code), opts);
}

export const GITHUB_REPO_OPTIONS: RepoFilesOptions = {
  name: 'forgestudio-site',
  readme:
    '# ForgeStudio Site\n\nGenerated and synced from ForgeStudio. Run `npm install` then `npm run dev` to preview locally.\n',
};

export const EXPORT_REPO_OPTIONS: RepoFilesOptions = {
  name: 'forgestudio-export',
  readme: '# ForgeStudio Export\n\nRun locally:\n\n```\nnpm install\nnpm run dev\n```\n',
};
