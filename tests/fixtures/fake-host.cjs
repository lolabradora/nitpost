// A disposable native messaging host for tests/chrome-ui.cjs. It answers from a JSON state file,
// appends every request to a log file and never delivers anything anywhere.
//
// State keys, all optional:
//   capabilities  reply to `capabilities` (default: a current helper), or 'hang' to never answer it
//   targets, starts, checks  what `targets` lists
//   listing       a whole reply to `targets`, for a helper that refuses to list
//   send          reply to `send` and `start` (default: a submitted receipt)
//   discovery     'exit' makes `targets` quit without answering, 'hang' never answers it
//   delivery      'exit' quits without answering a send, 'hang' never answers and stays alive
//   delay         milliseconds to wait before answering a send
const fs = require('node:fs');

const [statePath, logPath] = process.argv.slice(2);
const chunks = [];

function answer(reply) {
  const body = Buffer.from(JSON.stringify(reply));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]), () => process.exit(0));
}

function replyTo(request, state) {
  if (request.op === 'capabilities')
    return state.capabilities ?? {ok: true, shots: true, payload: 2};
  if (request.op === 'targets') {
    if (state.listing) return state.listing;
    return {
      ok: true,
      targets: state.targets ?? [],
      starts: state.starts ?? [],
      checks: state.checks ?? [],
    };
  }
  if (request.op === 'send' || request.op === 'start') {
    return state.send ?? {ok: true, receipt: 'submitted', notice: 'Typed into the fake pane.'};
  }
  return {ok: false, error: 'Unknown request.'};
}

// `silent` is how the request will end when it gets no answer. `accepted` is the reply's `ok`.
function handle(request) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const delivering = request.op === 'send' || request.op === 'start';
  const silences = {send: state.delivery, start: state.delivery, targets: state.discovery};
  const silent =
    request.op === 'capabilities' && state.capabilities === 'hang' ? 'hang' : silences[request.op];
  const reply = replyTo(request, state);
  fs.appendFileSync(
    logPath,
    JSON.stringify({...request, pid: process.pid, accepted: silent ? null : reply.ok === true}) +
      '\n',
  );
  if (silent === 'exit') process.exit(1);
  if (silent === 'hang') return;
  setTimeout(answer, delivering ? (state.delay ?? 0) : 0, reply);
}

// Chrome closes the pipe when it gives up or quits, which ends a host that was told to hang.
process.stdin.on('end', () => process.exit(0));

let handled = false;
process.stdin.on('data', chunk => {
  if (handled) return;
  chunks.push(chunk);
  const all = Buffer.concat(chunks);
  if (all.length < 4 || all.length < 4 + all.readUInt32LE(0)) return;
  handled = true;
  handle(JSON.parse(all.subarray(4, 4 + all.readUInt32LE(0)).toString('utf8')));
});
