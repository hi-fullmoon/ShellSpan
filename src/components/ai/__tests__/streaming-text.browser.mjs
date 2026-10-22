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
  cacheDir: `/tmp/shellspan-streaming-text-${process.pid}`,
  appType: 'custom',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
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
        await page.evaluate(source => window.streamingCheck.resetFollowing(source), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.evaluate(() => document.fonts.ready);
        // An untouched turn pins its question only until the reply fills the
        // viewport. From that boundary onward it must follow streamed output.
        await page.evaluate(source => window.streamingCheck.reset(source), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        assert.equal(await page.locator('[data-slot="message-scroller"]').getAttribute('data-scroll-mode'), 'anchored');
        await page.evaluate(() => window.streamingCheck.append('README.md\n\n'));
        assert.equal(await page.locator('[data-slot="message-scroller"]').getAttribute('data-scroll-mode'), 'anchored');
        const fillSamples = await page.evaluate(async source => {
          const samples = [];
          for (const paragraph of source.split('\n\n')) {
            window.streamingCheck.append(paragraph + '\n\n');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const viewport = document.querySelector('[data-message-scroller-viewport]');
            const content = document.querySelector('[data-slot="message-scroller-content"]');
            const anchor = content.querySelector('[data-scroll-anchor="true"]');
            const last = content.querySelector('[data-message-scroller-spacer]').previousElementSibling;
            const style = getComputedStyle(content);
            const turnHeight = last.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top
              + (parseFloat(style.paddingBlockStart) || 0) + (parseFloat(style.paddingBlockEnd) || 0);
            const mode = document.querySelector('[data-slot="message-scroller"]').dataset.scrollMode;
            samples.push({ mode, turnHeight, height: viewport.clientHeight,
              gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop });
            if (mode === 'following') break;
          }
          return samples;
        }, document);
        assert.ok(fillSamples.some(sample => sample.mode === 'anchored'), 'A partial answer must retain top alignment');
        assert.equal(fillSamples.at(-1)?.mode, 'following', 'Filling the viewport must automatically start following');
        assert.ok(fillSamples.every(sample => sample.mode === 'following'
          ? sample.turnHeight >= sample.height - 1 && sample.gap <= 8
          : sample.mode === 'anchored' && sample.turnHeight < sample.height - 1),
        `Follow must begin at the fill boundary: ${JSON.stringify(fillSamples)}`);
        const automaticallyFollowedGap = await page.evaluate(source => {
          window.streamingCheck.append('\n\n' + source);
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        }, document);
        assert.ok(automaticallyFollowedGap <= 8, 'An untouched full turn must follow subsequent output before paint');
        const streamingTail = await page.evaluate(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const spacer = document.querySelector('[data-message-scroller-spacer]');
          const last = spacer.previousElementSibling;
          return { spacerDisplay: getComputedStyle(spacer).display,
            trailingSpace: viewport.scrollHeight - viewport.scrollTop
              - (last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top) };
        });
        assert.equal(streamingTail.spacerDisplay, 'none', 'Following must release the turn spacer during generation');
        assert.ok(streamingTail.trailingSpace <= 17, 'Streaming must not expose empty scroll range below the actual answer');
        const tailViewport = page.locator('[data-message-scroller-viewport]');
        assert.equal(await tailViewport.evaluate(element => getComputedStyle(element).overscrollBehaviorY),
          'none', 'The transcript must disable elastic overscroll beyond the real answer tail');
        const tailTop = await tailViewport.evaluate(element => element.scrollTop);
        await tailViewport.hover();
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(200);
        assert.ok(Math.abs(await tailViewport.evaluate(element => element.scrollTop) - tailTop) <= 2,
          'A downward wheel gesture at the live tail must not scroll into empty space');
        assert.equal(await page.locator('[data-slot="message-scroller"]').getAttribute('data-scroll-mode'), 'following');
        await page.evaluate(source => window.streamingCheck.reset(source), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        assert.equal(await page.locator('[data-slot="message-scroller"]').getAttribute('data-scroll-mode'), 'anchored');
        await page.evaluate(source => window.streamingCheck.finishAnswer(source), document);
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const spacer = document.querySelector('[data-message-scroller-spacer]');
          return document.querySelector('[data-slot="message-scroller"]').dataset.scrollMode === 'following'
            && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8
            && getComputedStyle(spacer).display === 'none';
        });
        // Read a growing answer from its turn anchor with small native wheel
        // gestures. Each gesture must move locally rather than resume tailing.
        await page.evaluate(source => {
          window.streamingCheck.reset(source);
          window.streamingCheck.append(source);
        }, document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        const scrollport = page.locator('[data-message-scroller-viewport]');
        await scrollport.hover();
        await page.mouse.wheel(0, -100000);
        await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop < 2);
        await page.locator('[data-ai-node-key="user"]').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.waitForTimeout(80);
        await page.evaluate(source => {
          const chunks = source.split('\n\n');
          let index = 0;
          window.concurrentScrollStream = window.setInterval(() => {
            window.streamingCheck.append('\n\n' + chunks[index++ % chunks.length]);
          }, 16);
        }, document);
        for (let step = 0; step < 3; step++) {
          const before = await scrollport.evaluate(element => element.scrollTop);
          await page.mouse.wheel(0, 40);
          await page.waitForTimeout(120);
          const after = await scrollport.evaluate(element => ({ top: element.scrollTop,
            remaining: element.scrollHeight - element.clientHeight - element.scrollTop }));
          assert.ok(after.top > before && after.top - before <= 60,
            `A small downward gesture must not jump: ${JSON.stringify({ before, after })}`);
          assert.ok(after.remaining > 100, 'Reading must remain detached from the answer tail');
          await page.evaluate(source => window.streamingCheck.append('\n\n' + source), document);
          await page.waitForTimeout(80);
          assert.ok(Math.abs(await scrollport.evaluate(element => element.scrollTop) - after.top) < 2,
            'Continuing generation must preserve the manually chosen position');
        }
        await page.evaluate(() => window.clearInterval(window.concurrentScrollStream));
        assert.equal(await page.locator('[data-message-scroller-spacer]').evaluate(element => getComputedStyle(element).display),
          'none', 'Manual reading must not restore a released turn spacer');
        // A short anchored turn may currently share the physical bottom edge.
        // A downward reading gesture there must not opt into following when
        // the next streamed batch makes the answer taller than the viewport.
        await page.evaluate(source => window.streamingCheck.reset(source), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await scrollport.hover();
        await page.mouse.wheel(0, 40);
        await page.waitForTimeout(80);
        const shortTurnTop = await scrollport.evaluate(element => element.scrollTop);
        await page.evaluate(source => window.streamingCheck.append(source), document);
        await page.waitForTimeout(150);
        assert.ok(Math.abs(await scrollport.evaluate(element => element.scrollTop) - shortTurnTop) < 2,
          'Streaming past a short turn must not turn downward reading into tail following');
        assert.equal(await page.locator('[data-message-scroller-spacer]').evaluate(element => getComputedStyle(element).display),
          'none', 'A turn that fills while reading must release its obsolete top-alignment space');
        await scrollport.focus();
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop === 0);
        await page.evaluate(source => window.streamingCheck.finishAnswer(source), document);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-message-scroller-spacer]')).display === 'none');
        await page.waitForTimeout(100);
        assert.equal(await scrollport.evaluate(element => element.scrollTop), 0,
          'Completion must preserve history reading after releasing reserved space');
        assert.equal(await page.locator('[data-slot="message-scroller"]').getAttribute('data-following'), 'false');
        await scrollport.hover();
        const remaining = await scrollport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
        assert.ok(remaining > 100, 'Completed repository Markdown must still have a real scroll range');
        await page.mouse.wheel(0, remaining);
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1
            && document.querySelector('[data-slot="message-scroller"]').dataset.following === 'true';
        }, undefined, { timeout: 3000 }).catch(async error => {
          const state = await scrollport.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight,
            client: element.clientHeight, following: element.parentElement.dataset.following }));
          throw new Error(`${browserType.name()} ${width}: completed-wheel follow ${JSON.stringify(state)}`, { cause: error });
        });
        const endGap = await scrollport.evaluate(element => {
          const last = [...element.querySelectorAll('[data-message-id]')].at(-1);
          return element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
        });
        assert.ok(endGap <= 17, `The completed answer must have only its normal bottom padding: ${endGap}`);
        await page.evaluate(source => window.streamingCheck.resetFollowing(source), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        const layoutFollow = await page.evaluate(async source => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          await frame();
          await frame();
          // Submission transitions use this native CSS setting. Streaming
          // compensation must not inherit it and chase a moving destination.
          viewport.style.scrollBehavior = 'smooth';
          const gaps = [];
          for (const paragraph of source.split('\n\n').slice(0, 8)) {
            window.streamingCheck.append(paragraph + '\n\n');
            gaps.push(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
          }
          const top = viewport.scrollTop;
          for (let index = 0; index < 6; index++) await frame();
          const drift = viewport.scrollTop - top;
          viewport.style.scrollBehavior = '';
          return { gaps, drift };
        }, document);
        assert.ok(layoutFollow.gaps.every(gap => Math.abs(gap) <= 1),
          `Stream layout must align before paint even with smooth scrolling: ${JSON.stringify(layoutFollow)}`);
        assert.ok(Math.abs(layoutFollow.drift) <= 1,
          `Stream layout must not keep scrolling after its commit: ${layoutFollow.drift}`);
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
        assert.equal(initial.duration, 180);
        assert.equal(initial.initialAnimated, true);
        assert.ok(initial.samples.every((sample) => sample.filter === 'none'));
        assert.ok(initial.samples.every((sample) => sample.weight === initial.samples[0].weight
          && sample.size === initial.samples[0].size));
        assert.ok(initial.opacity > 0 && initial.opacity < 1);
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
        const boundary = await page.evaluate(async (source) => {
          const { splitStreamingMarkdown } = await import('/src/lib/streaming-markdown.ts');
          const chunks = splitStreamingMarkdown(source);
          const before = chunks[0] + chunks[1].split('\n')[0];
          window.streamingCheck.resetFollowing('');
          window.streamingCheck.append(before);
          document.getAnimations().forEach(animation => animation.finish());
          const answer = document.querySelector('[data-ai-node-key="answer"] .ai-assistant-answer');
          const last = answer.lastElementChild.lastElementChild;
          const text = last.textContent;
          const offset = last.getBoundingClientRect().top - answer.getBoundingClientRect().top;
          const height = answer.getBoundingClientRect().height;
          const count = answer.children.length;
          window.streamingCheck.append('\n');
          const moved = answer.lastElementChild.firstElementChild;
          const result = {
            split: answer.children.length === count + 1,
            tag: moved.tagName,
            unchanged: moved.textContent === text,
            offsetDelta: moved.getBoundingClientRect().top - answer.getBoundingClientRect().top - offset,
            heightDelta: answer.getBoundingClientRect().height - height,
            replayed: moved.getAnimations({ subtree: true }).length,
          };
          window.streamingCheck.append('\n' + source.split('\n').find(line => line.startsWith('本文件')));
          return { ...result, newAnimations: answer.lastElementChild.lastElementChild.getAnimations({ subtree: true }).length };
        }, document);
        assert.equal(boundary.split, true, 'Repository Markdown must exercise a chunk boundary');
        assert.match(boundary.tag, /^H[123]$/);
        assert.equal(boundary.unchanged, true);
        assert.ok(Math.abs(boundary.offsetDelta) < 1, 'A split must not move an already visible heading');
        assert.ok(Math.abs(boundary.heightDelta) < 1, 'A split must preserve answer height');
        assert.equal(boundary.replayed, 0, 'A split must not replay existing text animations');
        assert.ok(boundary.newAnimations > 0, 'New text after a split must still animate');

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
          const firstOpacity = Number(getComputedStyle(runs[0]).opacity);
          const lastOpacity = Number(getComputedStyle(runs[runs.length - 1]).opacity);
          animations.forEach((animation) => { animation.currentTime = 280; });
          return {
            samples,
            count: runs.length,
            text: document.querySelector('[data-ai-node-key="answer"]').textContent,
            expected: paragraph,
            firstOpacity,
            lastOpacity,
            settled: runs.every(run => getComputedStyle(run).opacity === '1'),
            duration: animations[0].effect.getTiming().duration,
          };
        }, document);
        assert.ok(stagger.count > 1 && stagger.count <= 8);
        assert.equal(stagger.text, stagger.expected);
        assert.ok(stagger.firstOpacity > stagger.lastOpacity);
        assert.equal(stagger.duration, 180);
        assert.equal(stagger.settled, true, 'A burst must become fully readable within 280ms');
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
        const paragraph = document.split('\n').find((line) => line.startsWith('- ') && !line.includes('`') && line.length > 80).slice(2);
        await page.evaluate((paragraph) => {
          window.streamingCheck.resetFollowing('');
          window.streamingCheck.append(paragraph.slice(0, 3));
        }, paragraph);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        const activeSelection = await page.evaluate((paragraph) => {
          const answer = document.querySelector('[data-ai-node-key="answer"]');
          const node = answer.querySelector('.ai-stream-text-fragment').firstChild;
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
          for (let offset = 3; offset < 80; offset++) window.streamingCheck.append(paragraph.slice(offset, offset + 1));
          const selected = selection.toString();
          const sameNode = selection.anchorNode === node;
          selection.removeAllRanges();
          window.streamingCheck.append(paragraph.slice(80));
          return { selected, sameNode, text: answer.textContent,
            fragments: answer.querySelectorAll('.ai-stream-text-fragment').length };
        }, paragraph);
        assert.equal(activeSelection.selected, paragraph.slice(0, 3));
        assert.equal(activeSelection.sameNode, true);
        assert.equal(activeSelection.text, paragraph);
        assert.ok(activeSelection.fragments <= 24, 'Deselection must restore bounded fragment storage');
        await page.evaluate(({ history, paragraph }) => {
          window.streamingCheck.resetFollowing(history);
          window.streamingCheck.append(paragraph);
        }, { history: document, paragraph });
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        const selectionStart = await page.evaluate(() => {
          const answer = document.querySelector('[data-ai-node-key="answer"]');
          const node = document.createTreeWalker(answer.querySelector('p'), NodeFilter.SHOW_TEXT).nextNode();
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, Math.min(3, node.length));
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return { top: document.querySelector('[data-message-scroller-viewport]').scrollTop, text: selection.toString() };
        });
        await page.evaluate(source => window.streamingCheck.append('\n\n' + source), document);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const paused = await page.evaluate(() => ({
          top: document.querySelector('[data-message-scroller-viewport]').scrollTop,
          text: window.getSelection().toString(),
        }));
        assert.ok(Math.abs(paused.top - selectionStart.top) < 3,
          `Selecting text must pause both layout and primitive follow: ${JSON.stringify({ selectionStart, paused })}`);
        assert.equal(paused.text, selectionStart.text);
        await page.evaluate(source => {
          window.getSelection().removeAllRanges();
          window.streamingCheck.append('\n\n' + source);
        }, document);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const detachedTop = await page.locator('[data-message-scroller-viewport]').evaluate(element => element.scrollTop);
        assert.ok(Math.abs(detachedTop - selectionStart.top) < 3, 'Clearing a selection must not jump away from the reading position');
        await page.locator('[data-slot="message-scroller-button"]').click();
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8;
        });
        const resumedGap = await page.evaluate(source => {
          window.streamingCheck.append('\n\n' + source);
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        }, document);
        assert.ok(resumedGap <= 8, 'Jump to latest must resume synchronous streaming follow');
        // Reopen a turn that was explicitly following its answer. Its saved
        // bottom intent must take precedence over the question's turn anchor.
        await page.evaluate(source => window.streamingCheck.reset(source), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.evaluate(source => window.streamingCheck.append(source), document);
        await scrollport.hover();
        await scrollport.focus();
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop === 0);
        await page.locator('[data-slot="message-scroller-button"]').click();
        await page.waitForFunction(() => window.streamingCheck.anchor()?.atBottom === true);
        await page.evaluate(() => window.streamingCheck.reopen());
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        const reopenedGap = await page.evaluate(source => {
          window.streamingCheck.append('\n\n' + source);
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        }, document);
        assert.ok(reopenedGap <= 8, 'Reopening at the bottom must preserve synchronous streaming follow');
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
