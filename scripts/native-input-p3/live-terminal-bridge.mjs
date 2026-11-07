import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Acceptance-only display bridge. It forwards actual PTY output and replies to
// actual numeric display/cursor requests; it cannot author editor input.
export async function driveTerminal(page, out, isActive) {
  let line = 0, reply = 0, bytes = 0, origin = 1;
  const observations = [];
  const readEvents = (complete = false) => {
    const file = path.join(out, 'live-events.jsonl');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (complete) assert(!text || text.endsWith('\n'), 'Producer ended with an incomplete timeline entry');
    return text.split('\n').slice(0, -1);
  };
  for (;;) {
    const lines = readEvents(), events = [];
    while (line < lines.length) {
      const event = JSON.parse(lines[line++]);
      assert.equal(event.offset, bytes);
      if (event.kind === 'data') bytes += event.bytes.length;
      else assert.equal(event.kind, 'resize');
      events.push(event);
    }
    if (events.length) {
      const replies = await page.evaluate(async events => {
        for (const event of events) {
          if (event.kind === 'resize') window.term.resize(event.cols, event.rows);
          else {
            const text = window.decoder.decode(Uint8Array.from(event.bytes), {stream: true});
            if (text) await new Promise(resolve => window.term.write(text, resolve));
          }
        }
        return window.replies.splice(0);
      }, events);
      for (const value of replies) {
        assert(/^\x1b\[[0-9]+;[0-9]+R$/.test(value));
        const target = path.join(out, 'reply-' + reply + '.txt');
        fs.writeFileSync(target + '.tmp', value, {flag: 'wx'});
        fs.renameSync(target + '.tmp', target);
        reply++;
      }
    }
    const requestFile = path.join(out, 'display-request-' + origin + '.json');
    if (fs.existsSync(requestFile)) {
      let request;
      try {request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));}
      catch (error) {if (!(error instanceof SyntaxError)) throw error;}
      if (request) {
        assert.equal(request.requestIndex, origin);
        const observation = await page.evaluate(request => window.observeOrigin(window.term, {
          requestId: request.requestIndex, columns: request.columns, rows: request.rows,
          cursorX: request.cursorX, cursorY: request.cursorY,
        }), request);
        if (observation) {
          const target = path.join(out, 'display-reply-' + origin + '.json');
          fs.writeFileSync(target + '.tmp', JSON.stringify({request, cellWidths: observation.cellWidths, wrapPending: observation.wrapPending}), {flag: 'wx'});
          fs.renameSync(target + '.tmp', target);
          observations.push({request, cells: observation.cellWidths.length, wrapPending: observation.wrapPending});
          origin++;
        }
      }
    }
    // The producer may finish and append its final bytes while evaluate awaits.
    // Only its current complete timeline, read after exit, proves a full drain.
    if (!isActive() && line === readEvents(true).length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  fs.writeFileSync(path.join(out, 'actual-xterm-responses.json'), JSON.stringify({
    responses: reply, rawBytesForwarded: bytes, timelineEvents: line,
    originObservations: observations,
    source: 'Actual installed xterm numeric cells and cursor replies; final timeline re-read after producer exit',
  }, null, 2), {flag: 'wx'});
}
