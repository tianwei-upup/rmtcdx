import { BusinessClient } from './business-client.mjs';
import { ConversationState, nearBottom, ProjectPins, DirectoryCache } from './chat-state.mjs';
import { markdown, copyText } from './markdown.mjs';
const $ = id => document.getElementById(id), client = new BusinessClient();
const cache = new Map(), drafts = new Map(), rows = new Map(), loadingSnapshots = new Map();
let selected = null, source = null, viewRevision = 0;
let deviceId = location.pathname.match(/^\/devices\/([\w-]+)/)?.[1] ?? 'mac', currentProject = '', deviceOnline = false;
let stickyBottom = true, renderFrame = null, toastTimer, unknownKey = null;
let projects = [];
const projectPins = new ProjectPins(localStorage);
const directory = new DirectoryCache(() => client.job('/api/devices/' + deviceId + '/sync', { resource: 'directory' }));
const expandedProjects = new Set(), visibleCounts = new Map();
let directoryTask = null, lastDirectoryAttempt = 0, treeSignature = '';
const native = /CodexRemoteAndroid/.test(navigator.userAgent);
if (native) document.documentElement.classList.add('native-shell');
const ERRORS = { login_required: '请重新登录', invalid_credentials: '密码不正确，请重新输入', login_rate_limited: '尝试次数较多，请稍后再试', network_unavailable: '连接中断，请检查网络后重试', device_offline: '电脑已离线，联网后可继续聊天', turn_not_running: '这次回答已经结束', conversation_not_found: '会话暂不可用，请刷新会话列表', precondition_rejected: '电脑暂时无法执行，请刷新会话后重试', execution_unknown: '发送结果尚未确认，请先核对会话', intent_conflict: '上次发送尚未核对，请先确认实际结果', task_still_running: '请求仍在处理中，可稍后刷新核对', result_expired: '内容已过期，请重新刷新', attachment_not_staged: '图片已过期，请重新添加', payload_capacity: '服务暂时繁忙，请稍后再试', invalid_image: '请添加 2 MiB 以内的 PNG、JPEG 或 WebP 图片' };
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200); }
function notice(text, error = false) { $('status').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
function diagnose(action, error) { console.warn(JSON.stringify({ event: 'business.ui.failure', action, code: error.code || 'client_error', uncertain: Boolean(error.uncertain) })); }
function failure(error, action = 'action') {
  diagnose(action, error);
  if (error.status === 401) { source?.close(); $('login').hidden = false; $('workspace').hidden = true; $('loginError').textContent = '登录已过期，请重新登录'; }
  else notice(ERRORS[error.code] || '操作未完成，请稍后重试', true);
  if (error.uncertain) { unknownKey = error.intentKey ?? unknownKey; $('review').hidden = false; $('reviewed').checked = false; }
}
const action = fn => async event => { try { await fn(event); } catch (error) { failure(error); } };
function scopeKey() { return deviceId + ':' + currentProject; }
function conversationKey(id) { return deviceId + ':' + id; }
function rememberSelection() { localStorage.setItem('rmt-last:' + scopeKey(), selected?.id ?? ''); }
function stateFor(id, title) {
  const key = conversationKey(id); if (!cache.has(key)) { const state = new ConversationState(id, title); state.projectId = currentProject; cache.set(key, state); }
  if (cache.size > 30) for (const [oldKey, value] of cache) if (value !== selected && !value.sending && !value.turnId && oldKey !== key) { cache.delete(oldKey); break; }
  return cache.get(key);
}
function blank() { const key = scopeKey(); if (!drafts.has(key) || drafts.get(key).id || drafts.get(key).sending) drafts.set(key, new ConversationState(null)); drafts.get(key).projectId = currentProject; return drafts.get(key); }
function saveDraft() { if (selected) selected.draft = $('text').value; }
function autosize() { $('text').style.height = 'auto'; $('text').style.height = Math.min($('text').scrollHeight, 170) + 'px'; }
function syncControls() {
  const running = Boolean(selected?.turnId) && ['running', 'approval'].includes(selected?.status), submitting = Boolean(selected?.sending);
  $('send').hidden = running; $('interrupt').hidden = !running;
  $('send').disabled = !deviceOnline || !projects.some(p => p.id === currentProject && p.available !== false) || submitting || !($('text').value.trim() || selected?.files.length);
  $('attach').disabled = submitting || (selected?.files.length ?? 0) >= 5;
  $('text').readOnly = submitting;
  $('composerContext').textContent = submitting ? '正在发送…' : running ? '生成中' : '';
  $('pending').hidden = !submitting && !['running', 'approval'].includes(selected?.status);
  $('pendingText').textContent = submitting ? '正在发送' : selected?.status === 'approval' ? '等待审批' : '正在思考';
  $('welcome').hidden = Boolean(selected?.messages.length || selected?.id);
  $('title').textContent = selected?.title || '新聊天';
  $('moreMessages').hidden = !selected?.cursor;
}
function imageElement(name) { const img = document.createElement('img'); img.src = '/icons/' + name + '.svg'; img.alt = ''; return img; }
function bottom(force = false) { if (force || stickyBottom) { $('chatScroll').scrollTop = $('chatScroll').scrollHeight; $('jumpBottom').hidden = true; } }
function renderMessages() {
  if (!selected) return;
  const stick = stickyBottom, ids = new Set(selected.messages.map(m => m.id));
  for (const [id, node] of rows) if (!ids.has(id)) { node.remove(); rows.delete(id); }
  for (const message of selected.messages) {
    let entry = rows.get(message.id);
    if (!entry) { entry = document.createElement('article'); entry.dataset.id = message.id; entry.className = 'message ' + message.role; entry.content = document.createElement('div'); entry.content.className = 'message-content'; entry.append(entry.content); rows.set(message.id, entry); }
    entry.classList.toggle('pending-message', Boolean(message.pending));
    const signature = message.text + ':' + Boolean(message.streaming) + ':' + (message.images?.length ?? 0);
    if (entry.signature !== signature) {
      entry.signature = signature; entry.content.replaceChildren();
      if (message.images?.length) { const images = document.createElement('div'); images.className = 'message-images'; for (const file of message.images) { const img = document.createElement('img'); img.src = file.url; img.alt = file.name || '已上传图片'; images.append(img); } entry.content.append(images); }
      entry.content.classList.toggle('streaming', Boolean(message.streaming));
      if (message.role === 'assistant' && !message.streaming) entry.content.append(markdown(message.text)); else { const text = document.createElement('span'); text.textContent = message.text; entry.content.append(text); }
      entry.actions?.remove();
      if (message.role === 'assistant' && !message.streaming && message.text) { const actions = document.createElement('div'); actions.className = 'message-actions'; const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'icon-button'; copy.setAttribute('aria-label', '复制回答'); copy.append(imageElement('copy')); copy.onclick = () => void copyText(message.text, copy); actions.append(copy); entry.append(actions); entry.actions = actions; }
    }
    // append only if needed: token updates must preserve native text selection and scroll.
    if (!entry.parentNode) $('messages').append(entry);
  }
  const ordered = selected.messages.map(m => rows.get(m.id));
  if ([...$('messages').children].some((node, i) => node !== ordered[i])) $('messages').replaceChildren(...ordered);
  syncControls(); if (stick) requestAnimationFrame(() => bottom());
}
function scheduleRender(state) { if (state !== selected || renderFrame) return; renderFrame = requestAnimationFrame(() => { renderFrame = null; renderMessages(); }); }
function renderFiles() {
  $('attachments').replaceChildren(); $('attachments').hidden = !selected?.files.length;
  for (const file of selected?.files ?? []) { const figure = document.createElement('div'); figure.className = 'attachment'; const img = document.createElement('img'); img.src = file.url; img.alt = file.name; const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-attachment'; remove.textContent = '×'; remove.setAttribute('aria-label', '移除图片 ' + file.name); remove.onclick = () => { const index = selected.files.indexOf(file); if (index >= 0) selected.files.splice(index, 1); URL.revokeObjectURL(file.url); renderFiles(); syncControls(); }; figure.append(img, remove); $('attachments').append(figure); }
}
function renderApprovals(state) {
  if (state !== selected) return; $('approvals').replaceChildren();
  for (const approval of state.approvals) { const card = document.createElement('section'); card.className = 'approval-card'; const title = document.createElement('strong'); title.textContent = 'Codex 需要确认'; const summary = document.createElement('p'); summary.textContent = approval.summary;
    const decline = document.createElement('button'); decline.textContent = '拒绝'; decline.disabled = !['command_approval', 'file_change_approval'].includes(approval.kind);
    decline.onclick = action(async () => { decline.disabled = true; try { await client.job('/api/conversations/' + state.id + '/approvals', { approvalId: approval.id, decision: 'decline' }, { writing: true }); await hydrate(state); } finally { decline.disabled = false; } }); card.append(title, summary, decline); $('approvals').append(card);
  }
}
async function hydrate(state, older = false) {
  if (!state.id) return;
  const key = conversationKey(state.id) + ':' + older;
  if (loadingSnapshots.has(key)) return loadingSnapshots.get(key);
  const pending = (async () => {
    const revision = state.revision, oldHeight = $('chatScroll').scrollHeight, oldTop = $('chatScroll').scrollTop;
    const value = await client.job('/api/conversations/' + state.id + '/snapshots', { pageSize: 30, ...(older && state.cursor ? { cursor: state.cursor } : {}) });
    if (!state.snapshot(value, older, revision)) return;
    if (state === selected) {
      renderMessages(); renderApprovals(state); $('title').textContent = state.title; directory.remember(state); renderCatalog();
      if (older) { stickyBottom = false; $('chatScroll').scrollTop = oldTop + $('chatScroll').scrollHeight - oldHeight; }
      $('review').hidden = !unknownKey && !client.pending('/api/conversations/' + state.id + '/turns');
    }
  })().finally(() => loadingSnapshots.delete(key)); loadingSnapshots.set(key, pending); return pending;
}
async function selectConversation(id, title, projectId = currentProject) {
  saveDraft();
  if (currentProject !== projectId) { currentProject = projectId; $('project').value = projectId; localStorage.setItem('rmt-project:' + deviceId, projectId); updateProjectLabel(); }
  expandedProjects.add(projectId); if (selected) selected.scrollTop = $('chatScroll').scrollTop;
  const revision = ++viewRevision; selected = stateFor(id, title); stickyBottom = !selected.loaded;
  rows.clear(); $('messages').replaceChildren(); $('text').value = selected.draft; autosize(); renderFiles(); renderMessages(); renderApprovals(selected); rememberSelection(); renderCatalog(); closePanel($('drawer'));
  if (selected.loaded) $('chatScroll').scrollTop = selected.scrollTop ?? $('chatScroll').scrollHeight;
  const state = selected; await hydrate(state);
  if (revision === viewRevision) { if (stickyBottom) bottom(true); notice(''); }
}
function newChat(options = {}) {
  if (!options.preserveSearch) $('search').value = '';
  saveDraft(); if (selected) selected.scrollTop = $('chatScroll').scrollTop;
  viewRevision++; selected = blank(); rows.clear(); $('messages').replaceChildren(); $('text').value = selected.draft; autosize(); renderFiles(); renderMessages(); $('approvals').replaceChildren(); stickyBottom = true; $('review').hidden = true; notice(''); rememberSelection(); renderCatalog(); if (!options.keepPanel) closePanel($('drawer'));
}
function chooseProject(id) {
  if (id === currentProject) return;
  saveDraft(); currentProject = id; $('project').value = id; localStorage.setItem('rmt-project:' + deviceId, id);
  updateProjectLabel(); newChat({ keepPanel: true, preserveSearch: true });
}
function renderCatalog() {
  const query = $('search').value.trim().toLocaleLowerCase(), pins = projectPins.read(deviceId);
  const ordered = projectPins.order(projects, deviceId);
  const signature = JSON.stringify([query, pins, [...expandedProjects], [...visibleCounts], currentProject, selected?.id, ordered.map(p => [p, directory.get(p.id).loaded, directory.get(p.id).nextCursor, directory.conversations(p.id)])]);
  if (signature === treeSignature) return; treeSignature = signature;
  const scroll = $('directoryScroll'), top = scroll.scrollTop, focusKey = document.activeElement?.dataset.focusKey;
  const fragment = document.createDocumentFragment(); let section = '', visible = 0;
  for (const project of ordered) {
    const entry = directory.get(project.id), conversations = directory.conversations(project.id);
    const projectMatch = project.name.toLocaleLowerCase().includes(query);
    const matches = query && !projectMatch ? conversations.filter(c => c.title.toLocaleLowerCase().includes(query)) : conversations;
    if (query && !projectMatch && !matches.length) continue;
    visible++;
    const groupName = pins.includes(project.id) ? '已置顶' : '项目';
    if (section !== groupName) { const label = document.createElement('p'); label.className = 'section-label'; label.textContent = groupName; fragment.append(label); section = groupName; }
    const group = document.createElement('section'); group.className = 'project-group'; group.dataset.projectId = project.id;
    const row = document.createElement('div'); row.className = 'project-row'; row.dataset.projectId = project.id;
    const expanded = Boolean(query) || expandedProjects.has(project.id);
    const choose = document.createElement('button'); choose.className = 'project-select'; choose.dataset.focusKey = project.id + ':toggle'; choose.setAttribute('aria-expanded', String(expanded)); choose.setAttribute('aria-current', String(project.id === currentProject));
    const caret = imageElement('caret-down'); caret.className = 'project-caret';
    const name = document.createElement('span'); name.className = 'project-label'; name.textContent = project.name;
    const count = document.createElement('span'); count.className = 'project-count'; count.textContent = entry.loaded ? conversations.length + (entry.nextCursor ? '+' : '') : '';
    choose.append(caret, name, count);
    if (project.available === false) choose.title = '目录不可用，可查看历史会话';
    choose.onclick = () => { if (expandedProjects.has(project.id)) expandedProjects.delete(project.id); else { expandedProjects.add(project.id); chooseProject(project.id); } renderCatalog(); };
    const pin = document.createElement('button'); pin.className = 'icon-button project-pin'; pin.dataset.focusKey = project.id + ':pin'; pin.setAttribute('aria-label', (pins.includes(project.id) ? '取消置顶 ' : '置顶 ') + project.name); pin.setAttribute('aria-pressed', String(pins.includes(project.id))); pin.append(imageElement('push-pin'));
    pin.onclick = () => { try { projectPins.toggle(deviceId, project.id); renderCatalog(); } catch { toast('无法保存置顶，请检查 App 存储空间'); } };
    row.append(choose, pin); group.append(row);
    const list = document.createElement('div'); list.className = 'project-sessions'; list.hidden = !expanded;
    const limit = query ? matches.length : (visibleCounts.get(project.id) ?? 8);
    for (const conversation of matches.slice(0, limit)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'session-row'; button.textContent = conversation.title || '新聊天'; button.dataset.id = conversation.id; button.dataset.projectId = project.id; button.dataset.focusKey = 'session:' + conversation.id; button.setAttribute('aria-current', String(selected?.id === conversation.id));
      button.onclick = action(() => selectConversation(conversation.id, conversation.title, project.id)); list.append(button);
    }
    if (!matches.length) { const empty = document.createElement('p'); empty.className = 'project-empty'; empty.textContent = entry.loaded ? '暂无会话' : '正在后台同步…'; list.append(empty); }
    if (!query && (matches.length > limit || entry.nextCursor)) { const more = document.createElement('button'); more.className = 'tree-more'; more.textContent = '显示更多会话'; more.onclick = action(async () => { if (matches.length > limit) visibleCounts.set(project.id, limit + 20); else { more.disabled = true; try { await loadCatalog(true, project.id); visibleCounts.set(project.id, limit + 20); } finally { more.disabled = false; } } renderCatalog(); }); list.append(more); }
    group.append(list); fragment.append(group);
  }
  $('projectList').replaceChildren(fragment); $('projectEmpty').hidden = visible > 0;
  scroll.scrollTop = top;
  if (focusKey) $('projectList').querySelector('[data-focus-key="' + CSS.escape(focusKey) + '"]')?.focus({ preventScroll: true });
}
function renderProjects() { renderCatalog(); }
async function refreshDirectory(force = false) {
  if (!$('login').hidden || document.hidden) return;
  if (directoryTask) return directoryTask;
  if (!force && (Date.now() - lastDirectoryAttempt < 5000 || directory.syncedAt && Date.now() - directory.syncedAt < 30000)) return;
  lastDirectoryAttempt = Date.now();
  $('directoryStatus').textContent = directory.syncedAt ? '后台更新中…' : '正在同步目录…';
  directoryTask = (async () => {
    const devices = await client.api('/api/devices'), device = devices.devices.find(d => d.id === deviceId);
    deviceOnline = Boolean(device?.online && device?.ready); syncControls();
    if (!deviceOnline) { $('directoryStatus').textContent = '电脑离线 · 保留已加载目录'; return; }
    await directory.refresh(force);
    projects = directory.projects;
    $('project').replaceChildren(...projects.map(p => new Option(p.name, p.id))); $('project').value = currentProject;
    if (!currentProject && projects.length) { currentProject = projects[0].id; expandedProjects.add(currentProject); selected = blank(); }
    updateProjectLabel(); renderCatalog(); syncControls();
    $('directoryStatus').dataset.syncedAt = String(directory.syncedAt); $('directoryStatus').textContent = '目录已更新';
  })().catch(error => { $('directoryStatus').textContent = directory.syncedAt ? '暂未更新 · 保留已加载目录' : '目录同步失败，请重试'; if (error.status === 401) failure(error, 'directory'); else diagnose('directory', error); }).finally(() => { directoryTask = null; });
  return directoryTask;
}
async function loadCatalog(append = false, projectId = currentProject) {
  if (!append) return refreshDirectory(true);
  const cursor = directory.get(projectId).nextCursor; if (!cursor || !deviceOnline) return;
  try { const value = await client.job('/api/devices/' + deviceId + '/sync', { resource: 'sessions', projectId, pageSize: 100, cursor }); directory.append(projectId, value); renderCatalog(); }
  catch (error) { if (error.code === 'precondition_rejected') { await refreshDirectory(true); toast('目录已变化，已更新最新会话'); } else throw error; }
}
async function connectEvents() {
  source?.close();
  let epoch = null, seq = 0, initialized = false;
  const activity = await client.api('/api/devices/' + deviceId + '/activity'); epoch = activity.epoch; seq = activity.events.at(-1)?.seq ?? 0;
  source = new EventSource('/api/devices/' + deviceId + '/events?after=' + seq);
  source.onopen = () => { if ($('status').textContent.startsWith('连接中断')) notice(''); if (initialized) { void refreshDirectory(true); if (selected?.id && !selected.sending) void hydrate(selected).catch(e => failure(e, 'reconnect_snapshot')); } initialized = true; };
  source.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.type === 'snapshot.required') { if (epoch && value.epoch && epoch !== value.epoch) { epoch = value.epoch; seq = 0; if (selected?.id && !selected.sending) void hydrate(selected).catch(e => failure(e, 'epoch_snapshot')); } return; }
    if (value.epoch && value.epoch !== epoch) { epoch = value.epoch; seq = 0; }
    if (value.seq <= seq) return; seq = value.seq;
    const state = cache.get(conversationKey(value.conversationId)); if (!state) return;
    if (!state.event(value)) return; scheduleRender(state);
    if (value.type === 'turn.finished') { setTimeout(() => void refreshDirectory(true), 1500); setTimeout(() => { if (!state.sending) void hydrate(state).catch(e => failure(e, 'completed_snapshot')); }, 300); }
    if (value.type === 'approval.pending') void hydrate(state).catch(e => failure(e, 'approval_snapshot'));
  };
  source.onerror = () => notice('连接中断，正在自动重连。已发送的消息不会重复提交。');
}
function updateProjectLabel() { $('projectName').textContent = projects.find(p => p.id === currentProject)?.name || '选择项目'; }
async function init() {
  const initialView = viewRevision;
  const value = await client.api('/api/devices'); $('login').hidden = true; $('workspace').hidden = false;
  $('device').replaceChildren(...value.devices.map(d => new Option(d.name + (d.online && d.ready ? ' · 在线' : ' · 离线'), d.id)));
  const device = value.devices.find(d => d.id === deviceId);
  if (!device) { $('device').append(new Option((deviceId === 'windows' ? 'Windows' : deviceId) + ' · 未连接', deviceId)); $('device').value = deviceId; deviceOnline = false; currentProject = ''; selected = blank(); renderMessages(); $('projectName').textContent = '电脑尚未连接'; notice('这台电脑尚未连接，请在电脑端启动执行器。'); return; }
  $('device').value = deviceId; deviceOnline = device.online && device.ready;
  const projectResult = await client.api('/api/devices/' + deviceId + '/projects');
  projects = projectResult.projects;
  $('project').replaceChildren(...projects.map(p => new Option(p.name, p.id)));
  currentProject = projects.some(p => p.id === localStorage.getItem('rmt-project:' + deviceId)) ? localStorage.getItem('rmt-project:' + deviceId) : (projects[0]?.id ?? '');
  $('project').value = currentProject; expandedProjects.add(currentProject); updateProjectLabel(); renderCatalog();
  $('connectionInfo').textContent = device.name + (deviceOnline ? ' · 已连接' : ' · 离线') + '\n' + location.origin;
  selected = blank(); renderMessages(); renderFiles();
  if (!deviceOnline) { notice('电脑已离线，已有对话仍保留在电脑上。'); return; }
  await Promise.all([connectEvents(), refreshDirectory(true)]);
  if (viewRevision !== initialView) return;
  const last = localStorage.getItem('rmt-last:' + scopeKey());
  if (last) await selectConversation(last, directory.conversations(currentProject).find(c => c.id === last)?.title);
  else newChat();
  notice('');
}
function openPanel(dialog) {
  const previous = document.querySelector('dialog[open]');
  if (previous === dialog) return;
  if (previous) { previous.close(); history.replaceState({ ...history.state, panel: dialog.id }, ''); }
  else history.pushState({ ...history.state, panel: dialog.id }, '');
  dialog.showModal();
  if (dialog.id === 'drawer') viewRevision++;
  if (dialog.id === 'drawer') { $('search').blur(); setTimeout(() => $('closeDrawer').focus({ preventScroll: true }), 30); }
}
function closePanel(dialog) { if (!dialog.open) return; if (history.state?.panel === dialog.id) history.back(); else dialog.close(); }
window.addEventListener('popstate', () => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });
for (const dialog of document.querySelectorAll('dialog')) { dialog.addEventListener('cancel', event => { event.preventDefault(); closePanel(dialog); }); dialog.addEventListener('click', event => { const r = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) closePanel(dialog); }); }
$('showSessions').onclick = () => openPanel($('drawer')); $('closeDrawer').onclick = () => closePanel($('drawer'));
$('settingsButton').onclick = $('drawerSettings').onclick = () => openPanel($('settings')); $('closeSettings').onclick = () => closePanel($('settings'));
$('context').onclick = () => openPanel($('drawer'));
$('refreshProjects').onclick = action(async () => { await refreshDirectory(true); });
$('new').onclick = $('drawerNew').onclick = newChat;
$('dismissNotice').onclick = () => notice('');
$('search').oninput = renderCatalog;
$('moreMessages').onclick = action(async () => { const state = selected; $('moreMessages').disabled = true; try { await hydrate(state, true); } finally { $('moreMessages').disabled = false; } });
$('project').onchange = () => { chooseProject($('project').value); expandedProjects.add(currentProject); renderCatalog(); openPanel($('drawer')); };
$('device').onchange = () => { saveDraft(); location.assign('/devices/' + encodeURIComponent($('device').value) + '/'); };
$('refresh').onclick = action(async () => { closePanel($('settings')); if (selected?.id) { await hydrate(selected); toast('会话已更新'); } else await init(); });
$('reviewRefresh').onclick = action(async () => { if (selected?.id) { await hydrate(selected); toast('已读取最新会话，请核对后确认'); } else { await loadCatalog(); openPanel($('drawer')); } });
$('resolveUnknown').onclick = () => { if (!$('reviewed').checked) { toast('请先刷新会话并核对实际结果'); return; } if (unknownKey) sessionStorage.removeItem(unknownKey); else if (selected?.id) client.clear('/api/conversations/' + selected.id + '/turns'); unknownKey = null; $('review').hidden = true; if (selected) { selected.sending = false; if (selected.status === 'unknown') selected.status = 'idle'; } syncControls(); toast('已结束待核对状态，下次发送将创建新请求'); };
$('text').oninput = () => { saveDraft(); autosize(); syncControls(); };
$('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer:fine)').matches) { event.preventDefault(); if (!$('send').disabled && !$('send').hidden) $('composer').requestSubmit(); } });
$('text').onfocus = () => document.documentElement.classList.add('typing'); $('text').onblur = () => document.documentElement.classList.remove('typing');
$('attach').onclick = () => $('image').click();
$('image').onchange = () => {
  if (!selected) return;
  for (const file of $('image').files) { if (selected.files.length >= 5) { toast('最多添加 5 张图片'); break; } if (file.size > 2097152 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { toast(ERRORS.invalid_image); continue; } selected.files.push({ file, id: crypto.randomUUID(), name: file.name, url: URL.createObjectURL(file) }); }
  $('image').value = ''; renderFiles(); syncControls();
};
async function base64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }
$('composer').onsubmit = async event => {
  event.preventDefault(); const state = selected, text = $('text').value.trim();
  if (!state || state.sending || state.turnId || !deviceOnline || !(text || state.files.length)) return;
  viewRevision++;
  const files = [...state.files], project = currentProject; state.draft = text; const optimistic = state.optimistic(text, files); state.files = []; $('text').value = ''; autosize(); renderFiles(); stickyBottom = true; renderMessages(); bottom(true); notice('');
  try {
    if (!state.id) {
      const result = await client.job('/api/devices/' + deviceId + '/conversations', { projectId: project }, { writing: true, scope: project });
      state.id = result.conversation.id; state.justCreated = true; cache.set(conversationKey(state.id), state); if (drafts.get(deviceId + ':' + project) === state) drafts.delete(deviceId + ':' + project);
      if (state === selected) rememberSelection(); directory.remember(result.conversation); renderCatalog();
    }
    const attachmentIds = [];
    for (const file of files) {
      if (!file.staged) { const value = await client.job('/api/conversations/' + state.id + '/attachments', { mime: file.file.type, base64: await base64(file.file) }, { writing: true, scope: file.id }); file.staged = value.attachmentId; }
      attachmentIds.push(file.staged);
    }
    const turn = await client.job('/api/conversations/' + state.id + '/turns', { text, attachmentIds }, { writing: true });
    state.draft = ''; optimistic.pending = false; state.accepted(turn.turnId);
    if (state === selected) { rememberSelection(); notice(''); }
    if (state.finished.has(turn.turnId)) void hydrate(state).catch(e => failure(e, 'early_finish_snapshot'));
    void loadCatalog().catch(e => diagnose('catalog_after_send', e));
  } catch (error) {
    state.sending = false; state.status = error.uncertain ? 'unknown' : 'failed'; optimistic.pending = false;
    if (!error.uncertain) { state.messages = state.messages.filter(m => m !== optimistic); state.files = files; state.draft = text; if (state === selected) { $('text').value = text; autosize(); renderFiles(); } }
    failure(error, 'send');
  }
  if (state === selected) renderMessages();
};
$('interrupt').onclick = action(async () => { const state = selected; if (!state?.id || !state.turnId) return; $('interrupt').disabled = true; try { await client.job('/api/conversations/' + state.id + '/interrupt', { turnId: state.turnId }, { writing: true }); toast('已请求停止'); } finally { $('interrupt').disabled = false; } });
$('chatScroll').addEventListener('scroll', () => { stickyBottom = nearBottom($('chatScroll').scrollTop, $('chatScroll').scrollHeight, $('chatScroll').clientHeight); $('jumpBottom').hidden = stickyBottom; }, { passive: true });
$('jumpBottom').onclick = () => { stickyBottom = true; bottom(true); };
function theme(value) { if (value === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value; localStorage.setItem('rmt-theme', value); $('theme').value = value; }
theme(localStorage.getItem('rmt-theme') || 'system'); $('theme').onchange = () => theme($('theme').value);
function viewport() { document.documentElement.style.setProperty('--app-height', (window.visualViewport?.height ?? window.innerHeight) + 'px'); if (stickyBottom) requestAnimationFrame(() => bottom()); }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
let pointer;
document.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY }; }, { passive: true });
document.addEventListener('pointerup', event => { if (!pointer || Math.abs(event.clientY - pointer.y) > 70) return; const delta = event.clientX - pointer.x; if (pointer.x < 24 && delta > 80 && !$('drawer').open) openPanel($('drawer')); else if ($('drawer').open && delta < -80) closePanel($('drawer')); pointer = null; }, { passive: true });
$('login').onsubmit = async event => { event.preventDefault(); $('loginSubmit').disabled = true; $('loginError').textContent = ''; try { await client.api('/api/login', { username: 'admin', password: $('password').value }); $('password').value = ''; await init(); } catch (error) { $('loginError').textContent = ERRORS[error.code] || '暂时无法连接，请稍后重试'; } finally { $('loginSubmit').disabled = false; } };
void init().catch(error => { if (error.status === 401) { $('login').hidden = false; $('workspace').hidden = true; } else failure(error, 'init'); });
// A backgrounded WebView stays alive; reconnect snapshots recover missed business events.
document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshDirectory(); if (selected?.id && !selected.sending) void hydrate(selected).catch(e => failure(e, 'foreground_snapshot')); } });
setInterval(() => { if (!document.hidden && $('login').hidden) void refreshDirectory(); }, 5000);
window.addEventListener('online', () => void refreshDirectory(true));
