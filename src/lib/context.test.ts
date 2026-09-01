import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Download, Page } from 'playwright';
import { buildContext } from './context.ts';
import { RunLog } from './log.ts';
import type { SiteConfig } from './types.ts';

type FixtureElement = {
  text: string;
  href?: string;
  role: string;
  visible: boolean;
};

class FixtureLocator {
  constructor(
    private readonly page: FixturePage,
    private readonly matches: FixtureElement[],
  ) {}

  async count(): Promise<number> {
    return this.matches.length;
  }

  nth(index: number): FixtureLocator {
    return new FixtureLocator(this.page, this.matches[index] ? [this.matches[index]] : []);
  }

  async isVisible(): Promise<boolean> {
    return this.matches[0]?.visible ?? false;
  }

  async click(): Promise<void> {
    const match = this.matches[0];
    if (!match) throw new Error('no fixture element to click');
    await this.page.click(match);
  }
}

class FixturePage {
  private currentUrl = '';
  readonly gotoCalls: string[] = [];

  async goto(url: string): Promise<null> {
    this.gotoCalls.push(url);
    this.currentUrl = this.resolve(url);
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  getByRole(role: string, options?: { name?: RegExp | string }): FixtureLocator {
    const name = options?.name;
    const matches = this.elements().filter((element) => {
      if (element.role !== role) return false;
      if (name === undefined) return true;
      return typeof name === 'string' ? element.text.includes(name) : name.test(element.text);
    });
    return new FixtureLocator(this, matches);
  }

  async click(element: FixtureElement): Promise<void> {
    if (!element.href) return;
    this.currentUrl = this.resolve(element.href);
  }

  private elements(): FixtureElement[] {
    if (!this.currentUrl.startsWith('file:///')) return [];
    const filePath = new URL(this.currentUrl);
    const html = fs.readFileSync(filePath, 'utf8');
    const matches = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gsi)];
    return matches.map((match) => ({
      href: match[1],
      text: stripTags(match[2] ?? ''),
      role: 'link',
      visible: true,
    }));
  }

  private resolve(url: string): string {
    return new URL(url, this.currentUrl || 'file:///').toString();
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').trim();
}

describe('buildContext reach', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-reach-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prefers clicking an in-page link over page.goto', async () => {
    const homePath = path.join(root, 'index.html');
    const documentsPath = path.join(root, 'documents.html');
    fs.writeFileSync(
      homePath,
      '<!doctype html><html><body><nav><a href="./documents.html?token=live">Documents</a></nav></body></html>',
    );
    fs.writeFileSync(documentsPath, '<!doctype html><html><body><main>Documents</main></body></html>');

    const page = new FixturePage();
    const site: SiteConfig = {
      id: 'geico',
      name: 'GEICO',
      loginUrl: 'https://example.com/login',
      homeUrl: new URL(`file:///${homePath.replace(/\\/g, '/')}`).toString(),
      source: 'geico',
    };
    await page.goto(site.homeUrl);

    const ctx = buildContext({
      page: page as unknown as Page,
      context: {} as BrowserContext,
      site,
      params: {},
      sinkFor: () => null,
      defaultSource: site.source,
      defaultYear: '2026',
      defaultMonth: '08',
      log: new RunLog('reach-test', { mirror: false }),
      tmpDir: path.join(root, 'tmp'),
      browserChannel: 'chromium',
    });

    await expect((ctx as { reach: (target: { text: RegExp }) => Promise<void> }).reach({ text: /Documents/ })).resolves.toBeUndefined();
    expect(page.url()).toBe(new URL('./documents.html?token=live', site.homeUrl).toString());
    expect(page.gotoCalls).not.toContain(new URL('./documents.html?token=live', site.homeUrl).toString());
  });
});
