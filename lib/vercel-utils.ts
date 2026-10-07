// Small pure helpers shared by the Vercel deploy + status routes.

export type DeployPhase = 'preparing' | 'deploying' | 'ready' | 'failed' | 'canceled';

/** Maps Vercel's readyState to the phase ForgeStudio shows. Unknown states are treated as still preparing, never as success. */
export function phaseFromState(state: string | null | undefined): DeployPhase {
  switch (state) {
    case 'READY':
      return 'ready';
    case 'ERROR':
      return 'failed';
    case 'CANCELED':
      return 'canceled';
    case 'BUILDING':
      return 'deploying';
    default:
      return 'preparing';
  }
}

/**
 * Picks the stable public production hostname for a deployment.
 * Prefers the shortest *.vercel.app alias (the project's production domain), then any alias,
 * and only falls back to the per-deployment URL when Vercel has not assigned an alias.
 */
export function pickProductionUrl(deployment: { url?: string | null; alias?: string[] | null }): string | null {
  const strip = (h: string) => h.replace(/^https?:\/\//, '');
  const aliases = (Array.isArray(deployment.alias) ? deployment.alias : [])
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map(strip);
  const stable = aliases.filter((a) => a.endsWith('.vercel.app')).sort((a, b) => a.length - b.length)[0];
  const chosen = stable || aliases[0] || (deployment.url ? strip(deployment.url) : '');
  return chosen ? `https://${chosen}` : null;
}
