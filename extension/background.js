// The service worker is the sole writer. Serialize mutations from different tabs
// so a second tab cannot overwrite a note or send the same batch twice.
const storage = chrome.storage.local;
const nativeHost = 'com.micovi.paneparcel';
const jpegPrefix = 'data:image/jpeg;base64,';
// Chrome's local storage holds 10 MB. Cap each image so drafts on many pages still fit,
// and so 50 notes with both images stay inside the companion's 16 MiB native frame.
const maxImageChars = 180000;
const maxReferenceChars = 120000;
const maxFrameBytes = 16 * 1024 * 1024;
const captureTimeout = 4000;
// How long to wait for the helper before giving up, per request. A helper that neither answers nor exits
// would otherwise hold the queue, and with it every tab. Delivery gets far longer than the helper's own
// limits add up to on a slow but working route (a Rex paste is about five commands of up to 15 s each).
// Choosing a folder waits on a person and has no limit here.
const hostLimits = {capabilities: 10000, targets: 30000, send: 120000, start: 120000};
const attemptRetention = 7 * 24 * 60 * 60 * 1000;
const attemptStatuses = ['pending', 'confirmed', 'submitted', 'unconfirmed', 'unknown', 'failed'];
const baseTitle = 'Annotate this page with PaneParcel';
const installHelper = 'Install the PaneParcel helper on your Mac, then try again.';
const storageFull = 'Chrome’s storage for PaneParcel is full. '
  + 'Remove notes or screenshots you no longer need, then try again.';
const referenceUnsaved = 'Chrome’s storage for PaneParcel is full, so the reference image was not saved. '
  + 'Remove notes or screenshots you no longer need, then paste it again.';
const superseded = 'This page was sent again or settled in another tab. Reopen the list to see where it stands.';
const interrupted = 'Chrome stopped PaneParcel before the helper answered. Check the destination before sending again.';
let pending = Promise.resolve();
let lastAttemptAt = 0;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function stringWithin(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function legacyDestinationScope(url) {
  if (url.protocol === 'file:') return new URL('.', url).href;
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com' && parts.length >= 2) {
    return url.origin + '/' + parts.slice(0, 2).join('/').toLowerCase();
  }
  return url.origin;
}

function validateProject(project) {
  requireValue(stringWithin(project, 4096) && project.startsWith('/'), 'Choose a project folder.');
  return project;
}

function validateTarget(target, project) {
  requireValue(target && (!target.project || target.project === project), 'Choose a conversation in this project.');
  if (target.agent && !target.block) {
    requireValue(['codex', 'claude'].includes(target.agent), 'Choose Codex or Claude Code.');
    return {agent: target.agent, project: validateProject(project)};
  }
  requireValue(stringWithin(target.session, 160) && stringWithin(target.block, 160)
    && stringWithin(target.label, 1024), 'Choose a listed conversation.');
  const result = {session: target.session, block: target.block, label: target.label};
  if (stringWithin(target.identity, 160)) result.identity = target.identity;
  requireValue(!['Terminal', 'iTerm2', 'codex-queue'].includes(target.session), 'Choose a live conversation.');
  if (project) result.project = validateProject(project);
  return result;
}

function preference(project, target, recentProjects) {
  const update = {lastDestination: {project, target}};
  if (project) update.recentProjects = [project, ...recentProjects.filter(path => path !== project)].slice(0, 12);
  return update;
}

function validateComment(comment) {
  requireValue(stringWithin(comment, 2000), 'Write a note of up to 2,000 characters.');
  return comment.trim();
}

function validateKind(kind) {
  if (kind === undefined) return 'change';
  requireValue(kind === 'change' || kind === 'question', 'Choose Change or Question for this note.');
  return kind;
}

function validateImage(value, maxLength, message) {
  requireValue(typeof value === 'string' && value.length <= maxLength && value.startsWith(jpegPrefix)
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(jpegPrefix.length)), message);
  return value;
}

function validateReference(value) {
  return validateImage(value, maxReferenceChars,
    'Paste a smaller reference image. PaneParcel keeps a JPEG of up to about 90 KB.');
}

function positiveInteger(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

// Document coordinates are negative left of the scroll origin, as on right-to-left pages.
function documentOffset(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 100000000;
}

function pickedElement(item) {
  return Boolean(item) && stringWithin(item.selector, 2048)
    && typeof item.text === 'string' && item.text.length <= 1000;
}

function absent(note, fields) {
  return fields.every(field => note[field] === undefined);
}

// Each scope carries only its own fields. An area never has a selector, so nothing downstream
// can mistake a region of the page for an element.
const scopeFields = {
  element(note) {
    requireValue(pickedElement(note) && absent(note, ['rect', 'elements']), 'Select the element again.');
    return {selector: note.selector, text: note.text};
  },
  area(note) {
    const rect = note.rect;
    requireValue(absent(note, ['selector', 'text', 'elements']) && rect
      && documentOffset(rect.x) && documentOffset(rect.y)
      && positiveInteger(rect.width, 100000) && positiveInteger(rect.height, 100000), 'Select the area again.');
    return {rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}};
  },
  group(note) {
    const elements = note.elements;
    requireValue(absent(note, ['selector', 'text', 'rect']) && Array.isArray(elements)
      && elements.length >= 2 && elements.length <= 8 && elements.every(pickedElement),
    'Select 2 to 8 elements for one note.');
    return {elements: elements.map(({selector, text}) => ({selector, text}))};
  }
};

function validateNote(note) {
  requireValue(note && stringWithin(note.id, 80) && positiveInteger(note.width, 100000)
    && positiveInteger(note.height, 100000), 'Select the element again.');
  const scope = note.scope ?? 'element';
  requireValue(Object.hasOwn(scopeFields, scope), 'Select an element, an area or several elements.');
  const result = {
    id: note.id, scope, kind: validateKind(note.kind), comment: validateComment(note.comment),
    width: note.width, height: note.height, ...scopeFields[scope](note)
  };
  if (note.image != null) {
    result.image = validateImage(note.image, maxImageChars, 'The screenshot is not usable. Save the note without it.');
  }
  if (note.reference != null) result.reference = validateReference(note.reference);
  return result;
}

// The crop box in CSS pixels, already clipped to the viewport. An unusable box means no screenshot.
function cropBox(message) {
  const {rect, dpr, width, height} = message;
  const usable = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1
    && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1
    && Number.isFinite(dpr) && dpr >= 0.25 && dpr <= 8;
  return usable ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr} : null;
}

function dataUrl(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return jpegPrefix + btoa(binary);
}

async function captureCrop(tab, box) {
  const capture = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
  // The capture shows whichever tab the window has in front. Discard it if the user switched meanwhile.
  if (!(await chrome.tabs.get(tab.id)).active) return null;
  const page = await createImageBitmap(await (await fetch(capture)).blob());
  try {
    const left = Math.min(Math.round(box.x * box.dpr), page.width);
    const top = Math.min(Math.round(box.y * box.dpr), page.height);
    const width = Math.min(Math.round(box.width * box.dpr), page.width - left);
    const height = Math.min(Math.round(box.height * box.dpr), page.height - top);
    if (width < 1 || height < 1) return null;
    for (const [longest, quality] of [[1200, 0.8], [800, 0.6]]) {
      const scale = Math.min(1, longest / Math.max(width, height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      canvas.getContext('2d').drawImage(page, left, top, width, height, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({type: 'image/jpeg', quality});
      const image = dataUrl(new Uint8Array(await blob.arrayBuffer()));
      if (image.length <= maxImageChars) return image;
    }
    return null;
  } finally {
    page.close();
  }
}

// The content script previews this crop before the note is saved. A note is worth saving without
// its screenshot, so every capture failure resolves to no image.
async function capture(message, sender) {
  const box = cropBox(message);
  if (!box || !sender.tab.active) return {ok: true, image: null};
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(resolve, captureTimeout, null); });
  try {
    return {ok: true, image: await Promise.race([captureCrop(sender.tab, box).catch(() => null), expired])};
  } finally {
    clearTimeout(timer);
  }
}

function unanswered(limit) {
  const seconds = limit / 1000;
  const waited = seconds >= 60 ? seconds / 60 + ' minutes' : seconds + ' seconds';
  return 'The PaneParcel helper did not answer within ' + waited + '.';
}

function hostFailure(message, connection, silent = false) {
  const failure = new Error(message);
  failure.connection = connection;
  failure.silent = silent;
  return failure;
}

// `connection` marks a helper Chrome could not talk to. `replied` marks a refusal the helper itself
// worded. `uncertain` is set unless the helper states that nothing was delivered: helpers released
// before that flag report a paste that already landed as a plain failure.
// `silent` marks a helper that did not answer in time. Its reply, if one ever comes, is ignored.
async function callHost(request) {
  const limit = hostLimits[request.op];
  let timer;
  const silence = new Promise((_, reject) => {
    if (limit) timer = setTimeout(reject, limit, hostFailure(unanswered(limit), 'unreachable', true));
  });
  let result;
  try {
    result = await Promise.race([chrome.runtime.sendNativeMessage(nativeHost, request), silence]);
  } catch (error) {
    if (error?.connection) throw error;
    const missing = /not found|forbidden/i.test(error?.message ?? '');
    throw missing ? hostFailure(installHelper, 'missing')
      : hostFailure('Could not reach the PaneParcel helper. Check the installation and refresh destinations.',
        'unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (result?.ok === true) return result;
  const refused = new Error(stringWithin(result?.error, 2000) ? result.error
    : 'The companion returned an unexpected response.');
  refused.replied = result?.ok === false;
  refused.uncertain = !(refused.replied && result.uncertain === false);
  throw refused;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// A helper that cannot be reached, or that refuses to list destinations, is a state the panel shows.
async function discover() {
  try {
    const result = await callHost({op: 'targets'});
    return {
      ok: true, connection: 'connected',
      targets: list(result.targets), starts: list(result.starts), checks: list(result.checks)
    };
  } catch (error) {
    const connection = error.connection ?? (error.replied ? 'error' : 'unreachable');
    const message = error.silent ? error.message + ' Refresh destinations to try again.' : error.message;
    return {ok: true, connection, targets: [], starts: [], checks: [], error: message};
  }
}

async function actionShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find(command => command.name === '_execute_action')?.shortcut || '';
  } catch {
    return '';
  }
}

async function actionTitle() {
  const shortcut = await actionShortcut();
  return shortcut ? baseTitle + ' (' + shortcut + ')' : baseTitle;
}

// A record still pending when it is read means the worker stopped mid-send: delivery is unknown.
async function currentAttempt(record, key) {
  if (!record || !attemptStatuses.includes(record.status) || !Array.isArray(record.ids)) return null;
  const delivered = record.status === 'confirmed' || record.status === 'submitted';
  if (delivered && Date.now() - record.at > attemptRetention) {
    await storage.remove(key);
    return null;
  }
  return record.status === 'pending' ? {...record, status: 'unknown', detail: interrupted} : record;
}

async function load(url) {
  const notesKey = 'notes:' + url.href;
  const attemptKey = 'attempt:' + url.href;
  const scope = legacyDestinationScope(url);
  const scopeKey = 'destination:' + scope;
  const legacyKey = 'target:' + url.origin;
  const stored = await storage.get(
    [notesKey, attemptKey, 'lastDestination', scopeKey, legacyKey, 'recentProjects', 'dim']);
  const saved = stored.lastDestination ?? stored[scopeKey]
    ?? {project: null, target: scope === url.origin ? stored[legacyKey] ?? null : null};
  return {
    url, notesKey, attemptKey, saved,
    notes: stored[notesKey] ?? [],
    attempt: await currentAttempt(stored[attemptKey], attemptKey),
    recentProjects: stored.recentProjects ?? [],
    dim: stored.dim !== false,
    unmigrated: !stored.lastDestination && Boolean(saved.project || saved.target)
  };
}

function storageError(error, fullMessage) {
  const reason = error?.message ?? '';
  return new Error(/quota/i.test(reason) ? fullMessage : 'Chrome could not save this: ' + reason + ' Try again.');
}

async function store(changes, fullMessage) {
  try {
    await storage.set(changes);
  } catch (error) {
    throw storageError(error, fullMessage);
  }
}

// Delivered records for pages nobody reopens would otherwise stay forever.
async function sweepAttempts() {
  const keys = (await storage.getKeys()).filter(key => key.startsWith('attempt:'));
  if (!keys.length) return;
  const stored = await storage.get(keys);
  for (const key of keys) await currentAttempt(stored[key], key);
}

async function saveNotes(page, notes) {
  if (notes.length) await store({[page.notesKey]: notes}, storageFull);
  else await storage.remove(page.notesKey);
}

function hasNote(page, id) {
  return page.notes.some(note => note.id === id);
}

async function state(page) {
  if (page.unmigrated) await storage.set({lastDestination: page.saved});
  return {
    ok: true, ...page.saved, recentProjects: page.recentProjects, dim: page.dim,
    notes: page.notes.map(({image, reference, ...note}) => (
      {...note, kind: note.kind ?? 'change', shot: Boolean(image), ref: Boolean(reference)})),
    attempt: page.attempt, shortcut: await actionShortcut()
  };
}

async function select(page, message) {
  const project = message.project || message.target?.project || null;
  if (project) validateProject(project);
  const target = message.target ? validateTarget(message.target, project) : null;
  requireValue(project || target, 'Choose a project.');
  await storage.set(preference(project, target, page.recentProjects));
}

async function add(page, message) {
  const note = validateNote(message.note);
  requireValue(page.notes.length < 50, 'Send or remove some notes first. Each page can hold 50.');
  requireValue(!hasNote(page, note.id), 'This note has already been saved.');
  const ref = Boolean(note.reference);
  if (note.image) {
    try {
      await storage.set({[page.notesKey]: [...page.notes, note]});
      return {ok: true, shot: true, ref};
    } catch {
      // Storage is full. Keep the note and leave out its screenshot.
    }
  }
  const {image, ...plain} = note;
  await store({[page.notesKey]: [...page.notes, plain]}, ref ? referenceUnsaved : storageFull);
  return {ok: true, shot: false, ref};
}

async function edit(page, message) {
  requireValue(hasNote(page, message.id), 'This note is no longer in the list.');
  const changes = {comment: validateComment(message.comment)};
  if (message.kind !== undefined) changes.kind = validateKind(message.kind);
  if (message.reference != null) changes.reference = validateReference(message.reference);
  if (message.text !== undefined) {
    // The excerpt is what the page said. The user may withhold it, never reword it.
    requireValue(message.text === '', 'An excerpt can be removed but not rewritten.');
    requireValue(page.notes.find(note => note.id === message.id).scope !== 'area',
      'An area note has no excerpt to remove.');
  }
  const revise = note => {
    const next = {...note, ...changes};
    if (message.text === '' && next.elements) next.elements = next.elements.map(item => ({...item, text: ''}));
    else if (message.text === '') next.text = '';
    if (message.shot === false) delete next.image;
    if (message.reference === null) delete next.reference;
    return next;
  };
  await store({[page.notesKey]: page.notes.map(note => note.id === message.id ? revise(note) : note)},
    changes.reference ? referenceUnsaved : storageFull);
}

function images(page, message) {
  const note = page.notes.find(item => item.id === message.id);
  requireValue(note, 'This note is no longer in the list.');
  return {ok: true, image: note.image ?? null, reference: note.reference ?? null};
}

async function remove(page, message) {
  const remaining = page.notes.filter(note => note.id !== message.id);
  await saveNotes(page, remaining);
  // An attempt that kept its notes has nothing left to report once the user removes them all.
  const kept = page.attempt && !['confirmed', 'submitted'].includes(page.attempt.status);
  if (kept && !page.attempt.ids.some(id => remaining.some(note => note.id === id))) {
    await storage.remove(page.attemptKey);
  }
}

async function resolve(page, message) {
  requireValue(message.action === 'received' || message.action === 'dismiss',
    'Choose whether the notes arrived.');
  requireCurrentAttempt(page, message);
  if (message.action === 'received') {
    await saveNotes(page, page.notes.filter(note => !page.attempt.ids.includes(note.id)));
  }
  await storage.remove(page.attemptKey);
}

function attemptTarget(target, project) {
  const starting = target.agent === 'codex' ? 'a new Codex conversation' : 'a new Claude Code conversation';
  return {
    label: target.label ?? starting, project: project || null,
    session: target.session ?? null, block: target.block ?? null
  };
}

// The user decides about the attempt their tab shows. Another tab may have replaced or settled it since.
function requireCurrentAttempt(page, message) {
  requireValue(page.attempt && message.attempt === page.attempt.at, superseded);
}

// An uncertain batch may already be in the conversation. Any further send from this page waits until
// the user has looked, so a double click or a second tab cannot deliver it twice.
function requireSettled(page, message) {
  const attempt = page.attempt;
  if (message.resend === true) return requireCurrentAttempt(page, message);
  if (!attempt || !['unconfirmed', 'unknown'].includes(attempt.status)) return;
  const when = new Date(attempt.at).toLocaleString([],
    {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  const batch = attempt.count === 1 ? '1 note' : attempt.count + ' notes';
  requireValue(!attempt.ids.some(id => hasNote(page, id)),
    'PaneParcel tried to send ' + batch + ' from this page to ' + attempt.target.label + ' on ' + when
    + ' and could not confirm that they arrived. Check there first, then send again only if they are missing.');
}

function planSend(page, message) {
  const project = message.target?.project || null;
  const destination = validateTarget(message.target, project);
  requireValue(Array.isArray(message.ids) && message.ids.length > 0, 'Add a note first.');
  requireSettled(page, message);
  const selected = page.notes.filter(note => message.ids.includes(note.id));
  requireValue(selected.length === message.ids.length, 'The notes have changed. Reopen the list before sending.');
  const starting = Boolean(destination.agent);
  const route = starting
    ? {op: 'start', agent: destination.agent, project}
    : {op: 'send', session: destination.session, block: destination.block};
  if (destination.identity) route.identity = destination.identity;
  if (!starting && project) route.project = project;
  const notes = selected.map(({id, ...note}) => ({...note, kind: note.kind ?? 'change'}));
  return {project, destination, starting, request: {...route, page: page.url.href, notes}};
}

async function helperCapabilities() {
  try {
    return await callHost({op: 'capabilities'});
  } catch (error) {
    if (error.connection) throw error;
    return {}; // Helpers released before screenshots reject this request.
  }
}

// Returns the notes this helper can take. Screenshots are optional and are dropped for a helper that
// predates them. An area, a group or a reference image is the note itself, so those are refused instead.
async function fitHelper(notes) {
  const extended = notes.some(note => note.scope === 'area' || note.scope === 'group' || note.reference);
  if (!extended && !notes.some(note => note.image)) return {notes, withoutShots: false};
  const helper = await helperCapabilities();
  requireValue(!extended || helper.payload >= 2, 'This PaneParcel helper cannot receive area notes, '
    + 'grouped elements or reference images. Update the helper, or use Copy for agent.');
  if (helper.shots === true) return {notes, withoutShots: false};
  return {notes: notes.map(({image, ...note}) => note), withoutShots: true};
}

// Chrome may escape a character of text as up to six bytes. Image data is plain ASCII.
function requireFrame(request) {
  let imageChars = 0;
  for (const note of request.notes) imageChars += (note.image?.length ?? 0) + (note.reference?.length ?? 0);
  const bytes = imageChars + 6 * (JSON.stringify(request).length - imageChars);
  requireValue(bytes <= maxFrameBytes, 'This batch is too large to send at once: its screenshots and reference '
    + 'images take ' + (imageChars / 1048576).toFixed(1) + ' MB and the helper accepts 16 MB. '
    + 'Remove a reference image or a screenshot from some notes, or remove some notes, then send again.');
}

function receiptOf(reply) {
  if (reply.receipt === undefined) return reply.keepNotes ? 'unconfirmed' : 'submitted';
  return ['confirmed', 'submitted'].includes(reply.receipt) ? reply.receipt : 'unconfirmed';
}

// The conversation a start created, or null when the helper did not identify it. The helper may name
// the project by its canonical path, which is then the one to keep.
function startedTarget(reply, project) {
  try {
    requireValue(reply.target?.block, 'The helper did not identify the new conversation.');
    return validateTarget(reply.target, reply.target.project ?? project);
  } catch {
    return null;
  }
}

// Resolves to what happened: {status, detail}, plus {target, notice} when the helper accepted the batch.
async function deliver(plan) {
  let fitted;
  try {
    fitted = await fitHelper(plan.request.notes);
    requireFrame({...plan.request, notes: fitted.notes});
  } catch (error) {
    return {status: 'failed', detail: error.message};
  }
  let reply;
  try {
    reply = await callHost({...plan.request, notes: fitted.notes});
  } catch (error) {
    if (error.silent) {
      return {status: 'unknown', detail: error.message + ' The batch may or may not have arrived. '
        + 'Check the destination before sending again.'};
    }
    if (error.connection === 'unreachable') {
      return {status: 'unknown',
        detail: 'The companion did not confirm delivery. Check the destination before sending again.'};
    }
    return {status: error.uncertain ? 'unknown' : 'failed', detail: error.message};
  }
  const target = plan.starting ? startedTarget(reply, plan.project) : plan.destination;
  if (!target) {
    return {status: 'unknown', detail: 'The helper started a conversation but did not say which one. '
      + 'Check your terminal before sending again.'};
  }
  const notice = fitted.withoutShots
    ? (reply.notice || 'Sent to ' + target.label + '.')
      + ' Screenshots were left out. Update the PaneParcel helper to include them.'
    : reply.notice;
  return {status: receiptOf(reply), detail: notice ?? '', target, notice};
}

async function settle(page, plan, record, outcome) {
  const final = {...record, status: outcome.status, detail: String(outcome.detail).slice(0, 300)};
  const changes = {[page.attemptKey]: final};
  if (outcome.target) {
    const project = outcome.target.project ?? plan.project;
    final.target = attemptTarget(outcome.target, project);
    Object.assign(changes, preference(project, outcome.target, page.recentProjects));
  }
  const removed = outcome.status === 'confirmed' || outcome.status === 'submitted';
  const remaining = page.notes.filter(note => !record.ids.includes(note.id));
  if (removed) changes[page.notesKey] = remaining;
  try {
    await storage.set(changes);
  } catch {
    // The pending record is still stored, so this batch reads as unknown and cannot be repeated unnoticed.
    const error = outcome.target
      ? 'The companion accepted the batch, but Chrome could not save the result. '
        + 'Check the conversation before retrying.'
      : outcome.detail;
    return {ok: false, error, attempt: await currentAttempt(record, page.attemptKey)};
  }
  if (removed && !remaining.length) await storage.remove(page.notesKey).catch(() => {});
  if (!outcome.target) return {ok: false, error: outcome.detail, attempt: final};
  return {ok: true, target: outcome.target, notice: outcome.notice, receipt: outcome.status, attempt: final};
}

// `at` identifies an attempt to the tab that later resends or resolves it, so it never repeats on a page,
// even when the previous record was dismissed within the same millisecond.
function attemptTime(page) {
  lastAttemptAt = Math.max(Date.now(), lastAttemptAt + 1, (page.attempt?.at ?? 0) + 1);
  return lastAttemptAt;
}

async function send(page, message) {
  let plan;
  try {
    plan = planSend(page, message);
  } catch (error) {
    return {ok: false, error: error.message, attempt: page.attempt};
  }
  const record = {
    at: attemptTime(page), status: 'pending', ids: [...message.ids], count: message.ids.length,
    target: attemptTarget(plan.destination, plan.project), detail: ''
  };
  try {
    // Written before the helper runs, so an interrupted worker leaves a trace of what it was sending.
    await storage.set({[page.attemptKey]: record});
  } catch (error) {
    const full = 'Chrome’s storage for PaneParcel is full. Remove notes or screenshots you no longer need, '
      + 'or use Copy for agent.';
    return {ok: false, error: 'Nothing was sent. ' + storageError(error, full).message, attempt: page.attempt};
  }
  return settle(page, plan, record, await deliver(plan));
}

const operations = {state, select, add, edit, images, remove, resolve, send};

function requirePage(message, sender) {
  requireValue(sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0, 'Unsupported sender.');
  const url = new URL(message.page);
  const source = new URL(sender.url);
  const samePage = url.protocol === 'file:'
    ? source.protocol === 'file:' && !url.host && !source.host && url.pathname === source.pathname
    : ['http:', 'https:'].includes(url.protocol) && url.origin === source.origin;
  requireValue(samePage, 'Reload the page to annotate it.');
  return url;
}

async function handle(message, sender) {
  const url = requirePage(message, sender);
  if (message.op === 'capture') return capture(message, sender);
  if (message.op === 'targets') return discover();
  if (message.op === 'chooseFolder') return callHost({op: 'chooseFolder'});
  if (message.op === 'dim') {
    await storage.set({dim: message.on === true});
    return {ok: true};
  }
  requireValue(Object.hasOwn(operations, message.op), 'Unknown annotation action.');
  return await operations[message.op](await load(url), message) ?? {ok: true};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Listing agent sessions can take a moment, and a screenshot must show the page as it is right now.
  // Neither reads or mutates drafts, so they do not wait behind queued writes or a send in progress.
  const unqueued = ['targets', 'chooseFolder', 'capture'].includes(message?.op);
  const task = unqueued ? handle(message, sender) : pending.then(() => handle(message, sender));
  const reply = task.then(respond, error => respond({ok: false, error: error.message}))
    .catch(() => {}); // The originating tab may close before we reply.
  if (!unqueued) pending = reply;
  return true;
});

chrome.action.onClicked.addListener(async tab => {
  if (tab.id == null) return;
  const tabId = tab.id;
  try {
    await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']});
    await chrome.action.setBadgeText({tabId, text: ''});
    await chrome.action.setTitle({tabId, title: await actionTitle()});
  } catch {
    const title = tab.url?.startsWith('file:')
      ? 'Enable Allow access to file URLs in PaneParcel’s extension details.'
      : 'PaneParcel cannot annotate this page. Open a web page or local HTML file.';
    await chrome.action.setTitle({tabId, title});
    await chrome.action.setBadgeText({tabId, text: '!'});
  }
});

// The tooltip names the shortcut Chrome has assigned, which the user may have changed or cleared.
actionTitle().then(title => chrome.action.setTitle({title})).catch(() => {});
// Queued like any other write, so it cannot remove a record a send is about to replace.
pending = pending.then(sweepAttempts).catch(() => {});
