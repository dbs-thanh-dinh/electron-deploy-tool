// Pure types/constants shared by the main process, the preload (type-only) and tests. No electron imports.

/** Ordered steps of a deploy. `write` = update the CICD file + `git add` + staged-changes check. */
export const DEPLOY_STEPS = ['stash', 'checkout', 'pull', 'write', 'commit', 'push'] as const;

export type DeployStepId = (typeof DEPLOY_STEPS)[number];

export type DeployStepStatus = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface DeployStepEventI {
  step: DeployStepId;
  status: DeployStepStatus;
}

/** Thrown inside a deploy when the user cancelled it; turned into `{ cancelled: true }` in the result. */
export class DeployCancelledError extends Error {
  constructor() {
    super('Deploy cancelled by user');
    this.name = 'DeployCancelledError';
  }
}
