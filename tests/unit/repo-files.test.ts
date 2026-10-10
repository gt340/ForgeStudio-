import { describe, it, expect } from 'vitest';
import { buildRepoFiles, SITE_DEPENDENCIES, GITHUB_REPO_OPTIONS, EXPORT_REPO_OPTIONS } from '@/lib/repo-files';

describe('lib/repo-files (shared by GitHub sync and ZIP export)', () => {
  it('builds the five site files with the given prepared code verbatim', () => {
    const files = buildRepoFiles("'use client';\nexport default function P(){return null}", GITHUB_REPO_OPTIONS);
    expect(Object.keys(files).sort()).toEqual(['README.md', 'app/layout.js', 'app/page.js', 'next.config.js', 'package.json']);
    expect(files['app/page.js']).toBe("'use client';\nexport default function P(){return null}");
  });

  it('GitHub and export differ only in package name and README', () => {
    const gh = buildRepoFiles('x', GITHUB_REPO_OPTIONS);
    const ex = buildRepoFiles('x', EXPORT_REPO_OPTIONS);
    for (const f of ['app/page.js', 'app/layout.js', 'next.config.js']) expect(ex[f]).toBe(gh[f]);
    const ghPkg = JSON.parse(gh['package.json']);
    const exPkg = JSON.parse(ex['package.json']);
    expect(ghPkg.name).toBe('forgestudio-site');
    expect(exPkg.name).toBe('forgestudio-export');
    expect({ ...ghPkg, name: '' }).toEqual({ ...exPkg, name: '' });
  });

  it('includes @supabase/supabase-js and does not let callers mutate the shared dependency table', () => {
    expect(SITE_DEPENDENCIES['@supabase/supabase-js']).toBe('2.45.4');
    const pkg = JSON.parse(buildRepoFiles('x', EXPORT_REPO_OPTIONS)['package.json']);
    pkg.dependencies.next = 'tampered';
    expect(SITE_DEPENDENCIES.next).toBe('14.2.32');
  });
});
