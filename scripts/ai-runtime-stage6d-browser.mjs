import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const output = await mkdtemp(join(tmpdir(), 'shellspan-files-e2e-'));
const ready = join(output, 'ready.json');
const rust = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', 'file_reference_browser_controller_http_bridge', '--', '--ignored', '--nocapture'], { detached: process.platform !== 'win32', stdio: 'inherit', env: { ...process.env, SHELLSPAN_FILES_BRIDGE_READY: ready } });
const completion = new Promise((resolve, reject) => { rust.once('error', reject); rust.once('exit', resolve); });
const origin = 'http://127.0.0.1:1449';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1449', '--strictPort'], { stdio: 'ignore' });
let browser, activePage;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Hold real native responses at the substituted desktop transport. The renderer
// still runs production cancellation/generation guards, including late errors.
async function verifyQueryRace(page, editor, bridgeUrl) {
  const evidence = [];
  const routeUrl = new URL(bridgeUrl).href;
  const bounded = promise => Promise.race([
    promise,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('controlled query did not reach transport barrier')), 5000); timer.unref(); }),
  ]);
  for (const order of [['plain', 'absent/', 'empty/'], ['absent/', 'plain', 'empty/'], ['empty/', 'plain', 'absent/']]) {
    await editor.fill('');
    const controls = new Map(['empty/', 'absent/', 'plain'].map(query => [query, {
      arrived: Promise.withResolvers(), release: Promise.withResolvers(), delivered: Promise.withResolvers(),
    }]));
    const routeHandler = async route => {
      const input = route.request().postDataJSON();
      const control = input?.command === 'agent_runtime_list_file_references' ? controls.get(input.args?.input?.query) : null;
      if (!control) return route.continue();
      try {
        const response = await route.fetch();
        control.arrived.resolve();
        await control.release.promise;
        await route.fulfill({ response });
        control.delivered.resolve();
      } catch (error) { control.arrived.reject(error); control.delivered.reject(error); }
    };
    await page.route(routeUrl, routeHandler);
    try {
      for (const query of ['empty/', 'absent/', 'plain']) {
        await editor.fill(`@${query}`); await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });
        await bounded(controls.get(query).arrived.promise);
      }
      for (const query of order) {
        controls.get(query).release.resolve();
        await bounded(controls.get(query).delivered.promise);
        if (query === 'plain') await page.getByRole('option', { name: 'plain.txt' }).waitFor();
      }
      await page.getByRole('option', { name: 'plain.txt' }).waitFor();
      assert.equal(await editor.inputValue(), '@plain');
      assert.equal(await page.getByRole('alert').count(), 0, 'stale absent error cannot replace current plain result');
      assert.equal(await page.getByText('No matching files or directories', { exact: true }).count(), 0);
      evidence.push({ requested: ['empty/', 'absent/', 'plain'], delivered: order, result: 'plain.txt' });
    } finally {
      for (const control of controls.values()) control.release.resolve();
      await page.unroute(routeUrl, routeHandler);
    }
  }
  return evidence;
}
try {
  let bridge;
  for (let i=0;i<1800;i++) { if (rust.exitCode !== null) throw new Error(`Rust exited ${rust.exitCode}`); try { bridge=JSON.parse(await readFile(ready,'utf8')); if ((await fetch(origin)).ok) break; } catch {} await delay(100); }
  assert.ok(bridge);
  const rpc = async (command,args={}) => { const r=await (await fetch(bridge.url,{method:'POST',body:JSON.stringify({command,args})})).json();if(r.error)throw new Error(r.error);return r.value; };
  browser=await chromium.launch({headless:true});const report=[];
  const orders=[['image','skill','file'],['file','image','skill'],['skill','file','image'],['image','file','skill'],['file','skill','image'],['skill','image','file'],['file'],['file']];
  for (const width of [320,400,560,720]) for (const theme of ['light','dark']) {
    const scene=report.length,zh=theme==='dark', order=orders[scene];
    const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});const page=await context.newPage();activePage=page;const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    const historyArrived = Promise.withResolvers(), historyRelease = Promise.withResolvers(), historyDelivered = Promise.withResolvers();
    if (scene === 0) await page.route(new URL(bridge.url).href, async route => {
      const input = route.request().postDataJSON();
      if (input?.command !== 'agent_runtime_list_sessions') return route.continue();
      historyArrived.resolve();
      // Fetch only after the cold project exists, reproducing the late initial
      // history response that used to steal the draft/image owner and menu.
      await historyRelease.promise;
      const response = await route.fetch();
      await route.fulfill({ response });
      historyDelivered.resolve();
    });
    await page.goto(`${origin}/?${new URLSearchParams({aiStage6dVisual:'',rpc:bridge.url,modelUrl:bridge.modelUrl,target:`files-${width}-${theme}`,theme,locale:zh?'zh-CN':'en-US'})}`);
    await page.locator('[data-stage6d-ready]').waitFor();const editor=page.getByTestId('ai-workspace-composer');
    if (scene === 0) await Promise.race([historyArrived.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('initial history did not reach transport barrier')), 5000); timer.unref();
    })]);
    const before=await rpc('__state');let bound=false;
    // No empty autocomplete addon while the editor has no active token.
    assert.equal(await page.locator('[data-file-completion]').count(),0);
    await editor.fill('mail user@example.com ');await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await delay(150);
    assert.equal((await rpc('__state')).pathQueries.length,before.pathQueries.length,'email does not trigger a query');
    for(const step of order) {
      if(step==='image') {
        await page.locator('input[type=file]').setInputFiles({name:bridge.image.name,mimeType:bridge.image.mediaType,buffer:Buffer.from(bridge.image.data,'base64')});
        await page.getByText(zh?'已保存草稿 · 尚未发送':'Saved draft · not sent').waitFor();
        if(!bound)assert.equal((await rpc('__state')).sessions.length,before.sessions.length,'image selection never makes rootless Session');
      } else if(step==='skill') {
        await editor.click(); await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); }); await editor.pressSequentially(' /sys');
        await page.getByRole('option',{name:/system-status/}).click();
      } else {
        await editor.click();await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await editor.pressSequentially('@sp');
        if(!bound){
          const draft=await editor.inputValue();await editor.press('Enter');await page.getByRole('dialog').waitFor();
          const dir=page.getByRole('textbox',{name:zh?'项目目录':'Project directory'});
          // Actual click and sequential key input catch React portal bubbling into the composer.
          await dir.click();await dir.pressSequentially(bridge.root);
          assert.equal(await dir.inputValue(),bridge.root);assert.equal(await editor.inputValue(),draft);
          await dir.press('Enter');await page.getByRole('dialog').waitFor({state:'hidden'});bound=true;
        }
        if (scene === 0) {
          await page.getByRole('option',{name:'space dir/'}).waitFor();
          const draft = await editor.inputValue();
          historyRelease.resolve(); await historyDelivered.promise;
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          // A transport roundtrip and rendering assertions, not an arbitrary sleep.
          const state = await rpc('__state');
          assert.equal(state.sessions.length, before.sessions.length + 1);
          assert.equal(await editor.inputValue(), draft);
          await page.getByText('Saved draft · not sent').waitFor();
          await page.getByRole('option',{name:'space dir/'}).waitFor();
          await writeFile(join(output, 'controlled-history-race.json'), JSON.stringify({
            historyReleasedAfter: ['image draft', 'cold project', 'visible file menu'],
            preserved: ['draft text', 'image owner', 'file menu'], requests: state.requests.length - before.requests.length,
          }, null, 2));
          await page.unroute(new URL(bridge.url).href);
        }
        await page.getByRole('option',{name:'space dir/'}).waitFor();
        await editor.press('ArrowDown');await editor.press('ArrowUp');await editor.press('Enter');
        assert.ok((await editor.inputValue()).endsWith('@"space dir/'));
        await page.getByRole('option',{name:'space dir/file name.txt'}).waitFor();
        await page.screenshot({path:join(output,`${width}-${theme}-completion.png`),animations:'disabled'});
        if(scene%2===0)await editor.press('Tab');else await page.getByRole('option',{name:'space dir/file name.txt'}).click();
        assert.ok((await editor.inputValue()).endsWith('@"space dir/file name.txt" '));
      }
    }
    assert.equal((await rpc('__state')).requests.length,before.requests.length,'completion/selection does not submit or call model');
    // Temporary query edits leave the intended prompt intact. Test real IME and keyboard escape/tab boundaries.
    const raw=await editor.inputValue();
    if(scene===0){
      await editor.fill('@match');await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await page.getByText(zh?/显示前 40/:/Showing the first 40/).waitFor();await editor.press('Escape');assert.equal(await page.getByRole('listbox').count(),0);
      await editor.fill('@empty/');await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await page.getByText(zh?'没有匹配的文件或目录':'No matching files or directories').waitFor();await editor.press('Tab');assert.equal(await editor.evaluate(e=>document.activeElement===e),false);
      await editor.fill('@absent/');await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await page.getByText(zh?/目录不存在/:/Directory no longer exists/).waitFor();await editor.press('Enter');assert.equal((await rpc('__state')).requests.length,before.requests.length);
      await editor.fill('@plain');await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await page.getByRole('option',{name:'plain.txt'}).waitFor();
      await editor.dispatchEvent('compositionstart');await editor.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true});await editor.dispatchEvent('compositionend');
      assert.equal((await rpc('__state')).requests.length,before.requests.length);await editor.fill('');assert.equal(await page.getByRole('listbox').count(),0);
      const races = await verifyQueryRace(page, editor, bridge.url);
      await writeFile(join(output, 'controlled-query-races.json'), JSON.stringify(races, null, 2));
      assert.equal((await rpc('__state')).requests.length,before.requests.length,'query races never call the model');
    }
    await editor.fill(raw);await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await delay(100);await editor.press('Enter');
    try { await page.getByText('Image wire complete',{exact:true}).waitFor({timeout:20000}); } catch(e) { await page.screenshot({path:join(output,'failure.png')});console.error('Scene',scene,await page.locator('body').innerText());throw e; }
    let captured=await rpc('__state');const session=captured.sessions.at(-1);
    assert.equal(session.snapshot.header.target.cwd,bridge.root);
    assert.equal(captured.requests.length,before.requests.length+1);
    const enqueued=session.events.filter(e=>e.type==='agent/inbox/spliced'&&e.data.operation==='enqueued').flatMap(e=>e.data.messages);
    assert.equal(enqueued[0].content,raw,'submitted ordinary prompt retains exact original spacing and mention');
    assert.equal(enqueued[0].images?.length??0,order.includes('image')?1:0);
    assert.ok(!JSON.stringify(captured.requests).includes('FILE_CONTENT_MUST_NEVER_BE_READ_6D'));
    assert.ok(JSON.stringify(captured.requests.at(-1)).includes('Completion does not read or attach content'));
    if(order.includes('skill'))assert.ok(JSON.stringify(captured.requests.at(-1)).includes('# System status'));
    await rpc('__restart');await page.reload();await editor.waitFor();
    // Wait for actual restored history, not merely the initial empty composer.
    await page.getByText('Image wire complete',{exact:true}).waitFor();
    await editor.fill('@pl');await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); });await page.getByRole('option',{name:'plain.txt'}).waitFor();
    assert.equal(await page.getByRole('button',{name:zh?'选择项目目录':'Choose project directory'}).count(),0,'restored Session uses frozen root');
    await editor.press('Tab');assert.equal(await editor.inputValue(),'@plain.txt ');await editor.pressSequentially('follow-up');await editor.press('Enter');
    for(let i=0;i<100;i++){captured=await rpc('__state');if(captured.requests.length===before.requests.length+2)break;await delay(100);}
    assert.equal(captured.requests.length,before.requests.length+2);
    assert.equal(captured.sessions.length,before.sessions.length+1,'restored completion does not create another Session');
    assert.equal(await page.locator('[data-message-scroller-viewport]').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:join(output,`${width}-${theme}-recovered.png`),animations:'disabled'});
    assert.deepEqual(errors,[]);report.push({width,theme,locale:zh?'zh-CN':'en-US',order,raw,restored:true});await context.close();
  }
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await rpc('__stop');assert.equal(await completion,0);
  console.log(`PASS ${report.length} real browser → controller → IPC payload → Rust → HTTP path scenes; evidence: ${output}`);
} catch(error) { if(activePage && !activePage.isClosed()) { await activePage.screenshot({path:join(output,'failure.png')}); await writeFile(join(output,'failure.html'),await activePage.content()); console.error('Failure evidence:',output,'UI:',await activePage.locator('body').innerText()); } throw error; } finally {await browser?.close();vite.kill('SIGTERM');if(rust.exitCode===null){if(process.platform!=='win32')process.kill(-rust.pid,'SIGTERM');else rust.kill('SIGTERM');await completion;}}
