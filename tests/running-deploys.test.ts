import { describe, expect, it } from 'vitest';
import { DEPLOY_STEPS, DeployCancelledError } from '../src/main/deploy-steps';
import { RunningDeploys } from '../src/main/running-deploys';

describe('RunningDeploys', () => {
  it('allows one deploy per window and several windows at once', () => {
    const registry = new RunningDeploys();
    expect(registry.start(1)).not.toBeNull();
    expect(registry.start(1)).toBeNull();
    expect(registry.start(2)).not.toBeNull();
    expect(registry.has(1)).toBe(true);
    expect(registry.has(3)).toBe(false);
  });

  it('cancel aborts only the signal of that window', () => {
    const registry = new RunningDeploys();
    const a = registry.start(1)!;
    const b = registry.start(2)!;
    expect(registry.cancel(1)).toBe(true);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(false);
  });

  it('cancel resolves false when nothing is running', () => {
    expect(new RunningDeploys().cancel(7)).toBe(false);
  });

  it('refuses to cancel once the commit started, and leaves the signal alone', () => {
    const registry = new RunningDeploys();
    const running = registry.start(1)!;
    registry.noteStep(running, { step: 'write', status: 'done' });
    registry.noteStep(running, { step: 'commit', status: 'done' }); // only "running" locks
    expect(running.locked).toBe(false);
    registry.noteStep(running, { step: 'commit', status: 'running' });
    expect(running.locked).toBe(true);
    expect(registry.cancel(1)).toBe(false);
    expect(running.controller.signal.aborted).toBe(false);
  });

  it('does not lock on a non-commit step that happens to be running', () => {
    const registry = new RunningDeploys();
    const running = registry.start(1)!;
    registry.noteStep(running, { step: 'pull', status: 'running' });
    expect(running.locked).toBe(false);
    expect(registry.cancel(1)).toBe(true);
  });

  it('finish frees the window for the next deploy', () => {
    const registry = new RunningDeploys();
    const running = registry.start(1)!;
    registry.finish(1, running);
    expect(registry.has(1)).toBe(false);
    expect(registry.cancel(1)).toBe(false);
    expect(registry.start(1)).not.toBeNull();
  });

  it('finish of an old deploy does not remove a newer entry for the same window', () => {
    const registry = new RunningDeploys();
    const old = registry.start(1)!;
    registry.finish(1, old);
    const newer = registry.start(1)!;
    registry.finish(1, old); // stale call
    expect(registry.has(1)).toBe(true);
    expect(registry.cancel(1)).toBe(true);
    expect(newer.controller.signal.aborted).toBe(true);
  });
});

describe('deploy-steps', () => {
  it('keeps the step order the UI relies on', () => {
    expect([...DEPLOY_STEPS]).toEqual(['stash', 'checkout', 'pull', 'write', 'commit', 'push']);
  });

  it('DeployCancelledError is an Error with a stable message', () => {
    const err = new DeployCancelledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Deploy cancelled by user');
    expect(err.name).toBe('DeployCancelledError');
  });
});
