import { describe, expect, it } from 'vitest';
import { describeDoc } from './driver.ts';

type Verb = {
  name: string;
  args: Array<{ name: string; type: string }>;
  output: string;
  effect: string;
  supports_dry_run?: boolean;
  notes?: string;
  is_alias?: boolean;
  destructive?: boolean;
  extra_args?: boolean;
};

const verbs = (describeDoc().verbs as Verb[]).filter((verb) => verb.is_alias !== true);

describe('driver naming convention', () => {
  it('uses canonical verb names, typed kebab-case args, and declared effects', () => {
    const types = ['string', 'int', 'float', 'bool', 'path', 'stdin', 'duration', 'array', 'object'];
    const outputs = ['json', 'ndjson', 'binary', 'none'];
    const effects = ['read', 'verify', 'mutate', 'render'];

    for (const verb of verbs) {
      const parts = verb.name.split(' ');
      expect(verb.name, `verb ${verb.name} must be trimmed`).toBe(verb.name.trim());
      expect(verb.name, `verb ${verb.name} must not contain double spaces`).not.toContain('  ');
      expect(parts.length, `verb ${verb.name} must have 1-3 words`).toBeGreaterThanOrEqual(1);
      expect(parts.length, `verb ${verb.name} must have 1-3 words`).toBeLessThanOrEqual(3);
      for (const part of parts) expect(part, `verb ${verb.name} has invalid word ${part}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(outputs, `verb ${verb.name} has invalid output ${verb.output}`).toContain(verb.output);
      expect(effects, `verb ${verb.name} has invalid effect ${verb.effect}`).toContain(verb.effect);

      for (const arg of verb.args) {
        expect(arg.name, `verb ${verb.name} arg ${arg.name} must be kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(types, `verb ${verb.name} arg ${arg.name} has invalid type ${arg.type}`).toContain(arg.type);
      }

      if (verb.effect === 'mutate') {
        const supportsDryRun = verb.args.some((arg) => arg.name === 'dry-run' && arg.type === 'bool') && verb.supports_dry_run === true;
        expect(supportsDryRun || (typeof verb.notes === 'string' && verb.notes.includes('dry-run')),
          `verb ${verb.name} mutates but needs dry-run support or explanatory notes`).toBe(true);
      }
      if (verb.destructive === true) expect(['read', 'render'], `verb ${verb.name} is destructive with effect ${verb.effect}`).not.toContain(verb.effect);
    }

    expect(verbs.map((verb) => verb.name)).toContain('version');
    expect(verbs.map((verb) => verb.name)).toContain('doctor');
    expect(verbs.find((verb) => verb.name === 'workflow run')?.extra_args, 'workflow run must forward extra args').toBe(true);
  });
});
