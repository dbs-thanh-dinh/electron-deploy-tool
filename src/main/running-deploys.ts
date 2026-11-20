import { DeployStepEventI } from './deploy-steps';

export interface RunningDeployI {
  controller: AbortController;
  /** The commit started: cancelling is no longer possible */
  locked: boolean;
}

/** Tracks the deploy each window is running (at most one per window) so it can be cancelled. No electron imports. */
export class RunningDeploys {
  private readonly byWindow = new Map<number, RunningDeployI>();

  /** Registers a deploy for the window; null when that window already has one running. */
  start(windowId: number): RunningDeployI | null {
    if (this.byWindow.has(windowId)) return null;
    const running: RunningDeployI = { controller: new AbortController(), locked: false };
    this.byWindow.set(windowId, running);
    return running;
  }

  /** Call for every step event: the commit starting locks the deploy against cancellation. */
  noteStep(running: RunningDeployI, event: DeployStepEventI): void {
    if (event.step === 'commit' && event.status === 'running') running.locked = true;
  }

  /** True when the abort was accepted; false when there is nothing to cancel or it is too late. */
  cancel(windowId: number): boolean {
    const running = this.byWindow.get(windowId);
    if (!running || running.locked) return false;
    running.controller.abort();
    return true;
  }

  /** Only removes the entry if it is still the same deploy (a newer one may have replaced it). */
  finish(windowId: number, running: RunningDeployI): void {
    if (this.byWindow.get(windowId) === running) this.byWindow.delete(windowId);
  }

  has(windowId: number): boolean {
    return this.byWindow.has(windowId);
  }
}
