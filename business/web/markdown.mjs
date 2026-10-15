import { safeLink } from './chat-state.mjs';
function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const value = match[0]; let element;
    if (value.startsWith('`')) { element = document.createElement('code'); element.textContent = value.slice(1, -1); }
    else if (value.startsWith('**')) { element = document.createElement('strong'); element.textContent = value.slice(2, -2); }
    else {
      const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(value), href = safeLink(parts[2]);
      element = document.createElement(href ? 'a' : 'span'); element.textContent = parts[1];
      if (href) { element.href = href; element.rel = 'noreferrer noopener'; }
    }
    parent.append(element); start = match.index + value.length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
export function markdown(text) {
  const fragment = document.createDocumentFragment(), lines = text.split('\n');
  let code = null, list = null, paragraph = null;
  for (const line of lines) {
    if (line.startsWith('```')) {
      paragraph = list = null;
      if (code) { code = null; continue; }
      const wrapper = document.createElement('div'); wrapper.className = 'code-block';
      const header = document.createElement('div'); header.className = 'code-header';
      const language = document.createElement('span'); language.textContent = line.slice(3).trim() || '代码';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '复制代码';
      const pre = document.createElement('pre'); code = document.createElement('code'); pre.append(code);
      const current = code; button.onclick = () => void copyText(current.textContent, button, '已复制');
      header.append(language, button); wrapper.append(header, pre); fragment.append(wrapper); continue;
    }
    if (code) { code.append(document.createTextNode((code.textContent ? '\n' : '') + line)); continue; }
    if (!line.trim()) { paragraph = list = null; continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line), bullet = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (heading) { paragraph = list = null; const h = document.createElement('h' + Math.min(heading[1].length + 1, 5)); inline(h, heading[2]); fragment.append(h); }
    else if (bullet) { paragraph = null; if (!list) { list = document.createElement(/^\d/.test(line) ? 'ol' : 'ul'); fragment.append(list); } const li = document.createElement('li'); inline(li, bullet[1]); list.append(li); }
    else { list = null; if (!paragraph) { paragraph = document.createElement('p'); fragment.append(paragraph); } else paragraph.append(document.createElement('br')); inline(paragraph, line); }
  }
  return fragment;
}
export async function copyText(text, button, success = '已复制') {
  try {
    let written = false;
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); written = true; } catch { /* Some WebViews need the selection-based fallback even on HTTPS. */ } }
    if (!written) { const input = document.createElement('textarea'); input.value = text; input.className = 'clipboard-fallback'; document.body.append(input); input.select(); const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error('copy_failed'); }
    const label = button.getAttribute('aria-label') || button.textContent; button.setAttribute('aria-label', success); button.dataset.copied = 'true';
    if (button.classList.contains('text-button')) button.textContent = success;
    setTimeout(() => { button.dataset.copied = 'false'; button.setAttribute('aria-label', label); if (button.classList.contains('text-button')) button.textContent = label; }, 1600);
  } catch { button.setAttribute('aria-label', '复制失败，请长按文字复制'); }
}
