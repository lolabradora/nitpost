// The service worker is the sole writer. Serialize mutations from different tabs
// so a second tab cannot overwrite a note or send the same batch twice.
const storage = chrome.storage.local;
const nativeHost = 'com.micovi.paneparcel';
let pending = Promise.resolve();

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function stringWithin(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function destinationScope(url) {
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
  if (typeof target.focusable === 'boolean') result.focusable = target.focusable;
  if (project) result.project = validateProject(project);
  return result;
}

function preference(scopeKey, project, target, recentProjects) {
  const update = {[scopeKey]: {project, target}};
  if (project) update.recentProjects = [project, ...recentProjects.filter(path => path !== project)].slice(0, 12);
  return update;
}

function validateComment(comment) {
  requireValue(stringWithin(comment, 2000), 'Write a note of up to 2,000 characters.');
  return comment.trim();
}

function validateNote(note) {
  requireValue(note && stringWithin(note.id, 80) && stringWithin(note.selector, 2048)
    && typeof note.text === 'string' && note.text.length <= 1000
    && Number.isSafeInteger(note.width) && note.width > 0
    && Number.isSafeInteger(note.height) && note.height > 0, 'Select the element again.');
  const {id, selector, text, width, height} = note;
  return {id, selector, text, width, height, comment: validateComment(note.comment)};
}

async function callHost(request) {
  let result;
  try {
    result = await chrome.runtime.sendNativeMessage(nativeHost, request);
  } catch (error) {
    if (/not found|forbidden/i.test(error.message)) {
      throw new Error('Install the PaneParcel helper on your Mac, then try again.');
    }
    throw new Error(['start', 'send'].includes(request.op)
      ? 'The companion did not confirm delivery. Check the destination before sending again.'
      : 'Could not reach the PaneParcel helper. Check the installation and refresh destinations.');
  }
  requireValue(result?.ok === true, result?.error || 'The companion returned an unexpected response.');
  return result;
}

async function handle(message, sender) {
  requireValue(sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0, 'Unsupported sender.');
  const url = new URL(message.page);
  const source = new URL(sender.url);
  const samePage = url.protocol === 'file:'
    ? source.protocol === 'file:' && !url.host && !source.host && url.pathname === source.pathname
    : ['http:', 'https:'].includes(url.protocol) && url.origin === source.origin;
  requireValue(samePage,
    'Reload the page to annotate it.');
  const pageKey = 'notes:' + url.href;
  const scope = destinationScope(url);
  const scopeKey = 'destination:' + scope;
  const legacyKey = 'target:' + url.origin;

  if (message.op === 'targets' || message.op === 'chooseFolder') return callHost({op: message.op});
  const stored = await storage.get([pageKey, scopeKey, legacyKey, 'recentProjects']);
  const notes = stored[pageKey] ?? [];
  const recentProjects = stored.recentProjects ?? [];
  // v0.1 stored one pane for the entire origin. Never assign that pane to
  // individual GitHub repositories on the user's behalf.
  const saved = stored[scopeKey] ?? {project: null, target: scope === url.origin ? stored[legacyKey] ?? null : null};
  switch (message.op) {
    case 'state':
      return {ok: true, notes, ...saved, recentProjects};
    case 'select': {
      const project = message.project || message.target?.project || null;
      if (project) validateProject(project);
      const target = message.target ? validateTarget(message.target, project) : null;
      requireValue(project || target, 'Choose a project.');
      await storage.set(preference(scopeKey, project, target, recentProjects));
      break;
    }
    case 'add': {
      const note = validateNote(message.note);
      requireValue(notes.length < 50, 'Send or remove some notes first. Each page can hold 50.');
      requireValue(!notes.some(item => item.id === note.id), 'This note has already been saved.');
      await storage.set({[pageKey]: [...notes, note]});
      break;
    }
    case 'edit':
      requireValue(notes.some(item => item.id === message.id), 'This note is no longer in the list.');
      await storage.set({[pageKey]: notes.map(item => item.id === message.id
        ? {...item, comment: validateComment(message.comment)} : item)});
      break;
    case 'remove': {
      const remaining = notes.filter(item => item.id !== message.id);
      if (remaining.length) await storage.set({[pageKey]: remaining});
      else await storage.remove(pageKey);
      break;
    }
    case 'send': {
      const project = message.target?.project || null;
      const destination = validateTarget(message.target, project);
      requireValue(Array.isArray(message.ids) && message.ids.length > 0, 'Add a note first.');
      const selected = notes.filter(item => message.ids.includes(item.id));
      requireValue(selected.length === message.ids.length, 'The notes have changed. Reopen the list before sending.');
      const starting = Boolean(destination.agent);
      const route = starting
        ? {op: 'start', agent: destination.agent, project}
        : {op: 'send', session: destination.session, block: destination.block};
      if (destination.identity) route.identity = destination.identity;
      if (!starting && project) route.project = project;
      const delivered = await callHost({
        ...route, page: url.href, notes: selected.map(({id, ...note}) => note)
      });
      const remaining = delivered.keepNotes ? notes : notes.filter(item => !message.ids.includes(item.id));
      let target = destination;
      try {
        if (starting) {
          requireValue(delivered.target?.block, 'Rex did not identify the new pane.');
          target = validateTarget(delivered.target, project);
        }
        await storage.set({...preference(scopeKey, project, target, recentProjects), [pageKey]: remaining});
      } catch {
        throw new Error('The companion accepted the batch, but Chrome could not save the result. Check the conversation before retrying.');
      }
      if (!remaining.length) await storage.remove(pageKey).catch(() => {});
      // Focus is a separate operation after delivery has been recorded. A window
      // activation failure must never invite a duplicate send.
      if (message.focus === true && target.focusable !== false) {
        try {
          await callHost({op: 'focus', session: target.session, block: target.block, project, identity: target.identity});
        } catch {
          return {ok: true, target, notice: delivered.notice, focusFailed: true};
        }
      }
      return {ok: true, target, notice: delivered.notice};
    }
    default:
      throw new Error('Unknown annotation action.');
  }
  return {ok: true};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Listing Rex processes can take a moment. Discovery doesn't read or mutate drafts.
  const discovery = ['targets', 'chooseFolder'].includes(message?.op);
  const task = discovery ? handle(message, sender) : pending.then(() => handle(message, sender));
  const reply = task.then(respond, error => respond({ok: false, error: error.message}))
    .catch(() => {}); // The originating tab may close before we reply.
  if (!discovery) pending = reply;
  return true;
});

chrome.action.onClicked.addListener(async tab => {
  if (tab.id == null) return;
  const tabId = tab.id;
  try {
    await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']});
    await chrome.action.setBadgeText({tabId, text: ''});
    await chrome.action.setTitle({tabId, title: 'Annotate this page with PaneParcel'});
  } catch {
    const title = tab.url?.startsWith('file:')
      ? 'Enable Allow access to file URLs in PaneParcel’s extension details.'
      : 'PaneParcel cannot annotate this page. Open a web page or local HTML file.';
    await chrome.action.setTitle({tabId, title});
    await chrome.action.setBadgeText({tabId, text: '!'});
  }
});
