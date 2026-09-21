import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__text-reveal', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__text-reveal',
    '<html><body><div id="root"></div><script type="module" src="/scripts/perf/ai-streaming-page.tsx"></script></body></html>'));
});
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');
const document = await readFile(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
const heading = document.split('\n')[0];

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'no-preference' });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}/__text-reveal`);
        await page.waitForFunction(() => Boolean(window.streamingCheck));
        const initial = await page.evaluate((heading) => {
          window.streamingCheck.resetFollowing('');
          window.streamingCheck.append(heading.slice(0, 8));
          window.streamingCheck.append(heading.slice(8));
          const fragments = document.querySelectorAll('.ai-stream-text-fragment');
          const fragment = fragments[fragments.length - 1];
          if (!fragment) throw new Error('Appended heading did not get a reveal fragment');
          const animation = fragment.getAnimations()[0];
          if (!animation) throw new Error('Reveal animation was not applied');
          animation.pause();
          animation.currentTime = 90;
          const headingNode = fragment.closest('h1');
          const samples = [0, 90, 210, 419].map((time) => {
            animation.currentTime = time;
            const style = getComputedStyle(fragment);
            return { filter: style.filter, weight: style.fontWeight, size: style.fontSize };
          });
          animation.currentTime = 90;
          return {
            samples,
            opacity: Number(getComputedStyle(fragment).opacity),
            text: fragment.textContent,
            duration: animation.effect.getTiming().duration,
            height: headingNode.getBoundingClientRect().height,
            initialAnimated: fragments[0].getAnimations().length > 0,
          };
        }, heading);
        assert.equal(initial.text, heading.slice(8));
        assert.equal(initial.duration, 420);
        assert.equal(initial.initialAnimated, true);
        assert.ok(initial.samples.every((sample) => sample.filter === 'none'));
        assert.ok(initial.samples.every((sample) => sample.weight === initial.samples[0].weight
          && sample.size === initial.samples[0].size));
        assert.ok(initial.opacity > 0 && initial.opacity < 0.5);
        await page.evaluate(() => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }));
        const visibleHeading = await page.locator('[data-ai-node-key="answer"] h1').boundingBox();
        assert.ok(visibleHeading && visibleHeading.y >= 0 && visibleHeading.y + visibleHeading.height <= 720);
        await page.screenshot({ path: `/tmp/shellspan-text-reveal-${browserType.name()}-${width}.png` });
        await page.evaluate(() => {
          document.getAnimations().forEach((animation) => animation.finish());
          const fragments = document.querySelectorAll('.ai-stream-text-fragment');
          const text = fragments[fragments.length - 1].firstChild;
          const range = document.createRange();
          range.selectNodeContents(text);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await page.waitForFunction((expected) => window.getSelection().toString() === expected, heading.slice(8));
        const settled = await page.evaluate((heading) => {
          window.streamingCheck.finishAnswer(heading);
          const node = document.querySelector('[data-ai-node-key="answer"]');
          return {
            fragments: node.querySelectorAll('.ai-stream-text-fragment').length,
            height: node.querySelector('h1').getBoundingClientRect().height,
            text: node.textContent,
            selection: window.getSelection().toString(),
            animated: node.querySelectorAll('.ai-stream-text-fragment[data-streaming]').length,
          };
        }, heading);
        assert.equal(settled.fragments, 2);
        assert.equal(settled.animated, 0);
        assert.equal(settled.selection, heading.slice(8));
        assert.equal(settled.height, initial.height);
        assert.equal(settled.text, heading.slice(2));
        // A final event may carry additional text. Previously selected nodes
        // must survive that append as well as a status-only completion.
        await page.evaluate((heading) => {
          window.streamingCheck.resetFollowing(heading);
          window.streamingCheck.append(heading.slice(0, 8));
        }, heading);
        await page.locator('[data-ai-node-key="answer"] h1').screenshot();
        await page.evaluate(() => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('[data-ai-node-key="answer"] h1 span').firstChild);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        });
        await page.waitForFunction((expected) => window.getSelection().toString() === expected, heading.slice(2, 8));
        const finalAppend = await page.evaluate((heading) => {
          window.streamingCheck.finishAnswer(heading);
          return {
            selected: window.getSelection().toString(),
            text: document.querySelector('[data-ai-node-key="answer"]').textContent,
            historicalFragments: document.querySelectorAll('[data-ai-node-key="history"] .ai-stream-text-fragment').length,
          };
        }, heading);
        assert.equal(finalAppend.selected, heading.slice(2, 8));
        assert.equal(finalAppend.text, heading.slice(2));
        assert.equal(finalAppend.historicalFragments, 0);

        const arrivals = await page.evaluate((source) => {
          window.streamingCheck.resetFollowing('');
          const lines = source.split('\n');
          window.streamingCheck.append(lines[0]);
          const heading = document.querySelector('[data-ai-node-key="answer"] h1 span');
          const paragraph = lines.find((line) => line.startsWith('本文件'));
          const items = lines.filter((line) => line.startsWith('- ')).slice(0, 2);
          window.streamingCheck.append('\n\n' + paragraph + '\n\n' + items.join('\n'));
          const answer = document.querySelector('[data-ai-node-key="answer"]');
          return {
            headingPreserved: answer.querySelector('h1 span') === heading,
            paragraphAnimated: answer.querySelector('p .ai-stream-text-fragment').getAnimations({ subtree: true }).length > 0,
            itemsAnimated: [...answer.querySelectorAll('li')].every((item) =>
              [...item.querySelectorAll('.ai-stream-text-fragment')].some((node) => node.getAnimations({ subtree: true }).length > 0)),
          };
        }, document);
        assert.deepEqual(arrivals, { headingPreserved: true, paragraphAnimated: true, itemsAnimated: true });
        const completion = await page.evaluate((heading) => {
          window.streamingCheck.resetFollowing('');
          window.streamingCheck.append(heading);
          const fragment = document.querySelector('.ai-stream-text-fragment');
          const animation = fragment.getAnimations()[0];
          animation.pause();
          animation.currentTime = 120;
          const opacity = getComputedStyle(fragment).opacity;
          window.streamingCheck.finishAnswer(heading);
          return {
            sameAnimation: fragment.getAnimations()[0] === animation,
            sameOpacity: getComputedStyle(fragment).opacity === opacity,
            time: animation.currentTime,
          };
        }, heading);
        assert.deepEqual(completion, { sameAnimation: true, sameOpacity: true, time: 120 });

        const stagger = await page.evaluate((source) => {
          window.streamingCheck.resetFollowing('');
          const paragraph = source.split('\n').find((line) =>
            line.startsWith('- ') && !line.includes('`') && line.length > 80).slice(2);
          window.streamingCheck.append(paragraph);
          const runs = [...document.querySelectorAll('.ai-stream-text-run')];
          const animations = runs.map((run) => run.getAnimations()[0]);
          animations.forEach((animation) => { animation.pause(); animation.currentTime = 120; });
          const samples = [0, 120, 300, 588].map((time) => {
            animations.forEach((animation) => { animation.currentTime = time; });
            return runs.map((run) => {
              const style = getComputedStyle(run);
              return { filter: style.filter, weight: style.fontWeight, size: style.fontSize };
            });
          });
          animations.forEach((animation) => { animation.currentTime = 120; });
          return {
            samples,
            count: runs.length,
            text: document.querySelector('[data-ai-node-key="answer"]').textContent,
            expected: paragraph,
            firstOpacity: Number(getComputedStyle(runs[0]).opacity),
            lastOpacity: Number(getComputedStyle(runs[runs.length - 1]).opacity),
            duration: animations[0].effect.getTiming().duration,
          };
        }, document);
        assert.ok(stagger.count > 1 && stagger.count <= 8);
        assert.equal(stagger.text, stagger.expected);
        assert.ok(stagger.firstOpacity > stagger.lastOpacity);
        assert.equal(stagger.duration, 420);
        for (const sample of stagger.samples) {
          assert.ok(sample.every((run, index) => run.filter === 'none'
            && run.weight === stagger.samples[0][index].weight
            && run.size === stagger.samples[0][index].size));
        }
        await page.evaluate(() => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }));
        await page.screenshot({ path: `/tmp/shellspan-text-wave-${browserType.name()}-${width}.png` });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const reducedRuns = await page.locator('.ai-stream-text-run').evaluateAll((runs) =>
          runs.every((run) => getComputedStyle(run).animationName === 'none' && getComputedStyle(run).opacity === '1'));
        assert.equal(reducedRuns, true);
        const reduced = await page.evaluate((heading) => {
          window.streamingCheck.resetFollowing('');
          window.streamingCheck.append(heading.slice(0, 8));
          window.streamingCheck.append(heading.slice(8));
          const node = document.querySelector('.ai-stream-text-fragment');
          return { animation: getComputedStyle(node).animationName, opacity: getComputedStyle(node).opacity };
        }, heading);
        assert.deepEqual(reduced, { animation: 'none', opacity: '1' });
        assert.deepEqual(errors, []);
        console.log(`${browserType.name()} ${width}px: first arrivals, selection-preserving completion, history, stable height and reduced motion passed`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
