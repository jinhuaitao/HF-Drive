// 前端通用工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const el = tag === 'svg' ? document.createElementNS(SVG_NS, 'svg') : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') {
        if (el instanceof SVGElement) el.setAttribute('class', v);
        else el.className = v;
      } else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'checked' || k === 'disabled' || k === 'draggable' || k === 'multiple' || k === 'selected') el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i ' + cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + units[i];
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = (now - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  const y = d.getFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return y === new Date().getFullYear() ? md : `${y}年${md}`;
}

export function fmtTimeFull(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const KIND_MAP = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'heic'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'flv'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'],
  pdf: ['pdf'],
  archive: ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz'],
  code: ['js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'scss', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'yml', 'yaml', 'toml', 'xml', 'ini', 'conf'],
  sheet: ['xls', 'xlsx', 'csv', 'numbers'],
  slide: ['ppt', 'pptx', 'key'],
  doc: ['doc', 'docx', 'rtf', 'pages', 'epub'],
  text: ['txt', 'md', 'markdown', 'log'],
};

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function fileKind(name, mime = '') {
  const ext = extOf(name);
  for (const [kind, exts] of Object.entries(KIND_MAP)) {
    if (exts.includes(ext)) return kind;
  }
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const KIND_ICON = {
  image: 'image', video: 'video', audio: 'audio', pdf: 'file', archive: 'archive',
  code: 'code', sheet: 'sheet', slide: 'slide', doc: 'doc', text: 'doc', file: 'file',
};

export function fileIcon(kind, extraClass = '') {
  const box = h('div', { class: `fi ${kind} ${extraClass}`.trim() }, icon(KIND_ICON[kind] || 'file'));
  return box;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
export function toast(message, type = 'info') {
  const root = $('#toast-root');
  if (!root) return;
  const el = h('div', { class: `toast ${type}` },
    icon(type === 'ok' ? 'check' : type === 'err' ? 'info' : 'info'),
    h('span', { text: message })
  );
  root.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 260);
  }, type === 'err' ? 4200 : 2600);
}

/* ---------------- 弹窗 ---------------- */
export function openModal({ title, subtitle, body, footer, wide = false, onClose, closeOnBackdrop = true }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}` },
    h('div', { class: 'modal-head' },
      h('div', {},
        h('h3', { text: title || '' }),
        subtitle ? h('p', { text: subtitle }) : null
      ),
      h('button', { class: 'icon-btn close-btn', onclick: close, title: '关闭' }, icon('x'))
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null
  );
  backdrop.append(modal);
  if (closeOnBackdrop) {
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
  }
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  return { close, el: modal, backdrop };
}

export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      ref.close();
      resolve(v);
    };
    const ref = openModal({
      title,
      body: h('p', { class: 'desc', style: 'margin:0;color:var(--text-2);font-size:13.5px;line-height:1.6', text: message }),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(false), text: cancelText }),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true), text: okText }),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', okText = '确定', type = 'text' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder, type });
    const finish = (v) => {
      if (done) return;
      done = true;
      ref.close();
      resolve(v);
    };
    const submit = () => finish(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const ref = openModal({
      title,
      body: h('div', { class: 'field', style: 'margin:0' },
        label ? h('label', { text: label }) : null,
        input
      ),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(null), text: '取消' }),
        h('button', { class: 'btn btn-primary', onclick: submit, text: okText }),
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      if (type === 'text' && dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    }, 60);
  });
}

/* ---------------- 极简 Markdown ---------------- */
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  let out = '';
  let inCode = false;
  let codeBuf = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out += `</${listType}>`;
      listType = null;
    }
  };

  const inline = (text) => {
    let t = escapeHtml(text);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src2) => {
      const url = safeUrl(src2);
      return url ? `<img src="${url}" alt="${alt}" />` : alt;
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const url = safeUrl(href);
      return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    } else if (/^\s*([-*+])\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul'; }
      out += `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out += '<ol>'; listType = 'ol'; }
      out += `<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
    } else if (/^>\s?/.test(line)) {
      closeList();
      out += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`;
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      out += '<hr />';
    } else if (/^\|.*\|$/.test(line.trim())) {
      closeList();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|');
      if (/^[\s:-]+$/.test(cells.join(''))) continue;
      out += `<table><tr>${cells.map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr></table>`;
    } else {
      closeList();
      out += `<p>${inline(line)}</p>`;
    }
  }
  if (inCode) out += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
  closeList();
  return out;
}

function safeUrl(url) {
  const u = String(url).trim();
  if (/^https?:\/\//i.test(u)) return escapeHtml(u);
  if (/^mailto:/i.test(u)) return escapeHtml(u);
  return null;
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function joinPath(dir, name) {
  if (!dir || dir === '/') return '/' + name;
  return dir.replace(/\/$/, '') + '/' + name;
}
