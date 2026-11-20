import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')) as {
  engines?: { node?: string };
};

describe('package.json engines', () => {
  const ours = readJson('package.json').engines?.node;
  const jsdom = readJson('node_modules/jsdom/package.json').engines?.node;

  it('declares a Node range', () => {
    expect(ours).toBeTruthy();
  });

  // The renderer tests run on jsdom, so contributors need a Node version jsdom supports (e.g. not Node 23).
  // If jsdom is upgraded and this fails, update engines.node (and the Node line in README.md) to match.
  it('matches the Node range supported by the installed jsdom', () => {
    expect(jsdom).toBeTruthy();
    expect(ours).toBe(jsdom);
  });
});
