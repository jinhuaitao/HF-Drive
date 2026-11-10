// 文件预览
import { h, icon, fmtBytes, fileKind, renderMarkdown, toast, extOf } from './util.js';

let current = null;

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'];
const VIDEO = ['mp4', 'webm', 'mov', 'm4v', 'mkv'];
const AUDIO = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'];
const TEXT = ['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'log', 'csv', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'svg'];

export function isPreviewable(node) {
  if (!node || node.type !== 'file') return false;
  const ext = extOf(node.name);
  return IMAGE.includes(ext) || VIDEO.includes(ext) || AUDIO.includes(ext) || ext === 'pdf' || TEXT.includes(ext);
}

export function openPreview(node, list = []) {
  closePreview();
  const previewable = list.filter(isPreviewable);
  let index = previewable.findIndex((n) => n.id === node.id);
  if (index === -1) {
    previewable.unshift(node);
    index = 0;
  }

  const overlay = h('div', { class: 'preview' });
  const body = h('div', { class: 'preview-body' });
  const head = h('div', { class: 'preview-head' });

  const renderHead = (n) => {
    head.replaceChildren(
      h('div', { style: 'min-width:0' },
        h('div', { class: 'pname', text: n.name }),
        h('div', { class: 'psub', text: `${fmtBytes(n.size)} · ${(n.mime || '').split(';')[0] || '未知类型'}` })
      ),
      h('div', { class: 'spacer' }),
      h('a', {
        class: 'icon-btn', href: `/api/file/${n.id}`, title: '下载', download: n.name,
      }, icon('download')),
      h('button', { class: 'icon-btn', title: '关闭 (Esc)', onclick: closePreview }, icon('x'))
    );
  };

  const renderBody = async (n) => {
    body.replaceChildren(h('div', { class: 'preview-loading' }, h('div', { class: 'spinner', style: 'width:22px;height:22px;margin:0' }), '加载中…'));
    const ext = extOf(n.name);
    const url = `/api/file/${n.id}?inline=1`;

    if (IMAGE.includes(ext) || (n.mime || '').startsWith('image/')) {
      const img = h('img', { src: url, alt: n.name });
      img.addEventListener('error', () => {
        body.replaceChildren(fallbackBox(n, '图片加载失败'));
      });
      body.replaceChildren(img);
      return;
    }
    if (VIDEO.includes(ext) || (n.mime || '').startsWith('video/')) {
      body.replaceChildren(h('video', { src: url, controls: true, autoplay: true, playsinline: true }));
      return;
    }
    if (AUDIO.includes(ext) || (n.mime || '').startsWith('audio/')) {
      body.replaceChildren(
        h('div', { style: 'text-align:center;color:#fff' },
          h('div', { style: 'width:96px;height:96px;border-radius:28px;background:rgba(255,255,255,.1);display:grid;place-items:center;margin:0 auto 22px' }, icon('audio', 'lg')),
          h('div', { style: 'font-size:15px;font-weight:600;margin-bottom:18px', text: n.name }),
          h('audio', { src: url, controls: true, autoplay: true })
        )
      );
      return;
    }
    if (ext === 'pdf') {
      body.replaceChildren(h('iframe', { src: url, title: n.name }));
      return;
    }
    if (TEXT.includes(ext) || (n.mime || '').startsWith('text/')) {
      try {
        const res = await fetch(`/api/file/${n.id}?inline=1&max=524288`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (ext === 'md' || ext === 'markdown') {
          const md = h('div', { class: 'preview-md' });
          md.innerHTML = renderMarkdown(text);
          body.replaceChildren(md);
        } else {
          body.replaceChildren(h('pre', { class: 'preview-text', text }));
        }
      } catch (err) {
        body.replaceChildren(fallbackBox(n, '文本读取失败：' + err.message));
      }
      return;
    }
    body.replaceChildren(fallbackBox(n, '该类型暂不支持在线预览'));
  };

  const fallbackBox = (n, message) =>
    h('div', { style: 'text-align:center;color:#fff' },
      h('div', { style: 'width:96px;height:96px;border-radius:28px;background:rgba(255,255,255,.1);display:grid;place-items:center;margin:0 auto 20px' }, icon('file', 'lg')),
      h('div', { style: 'font-size:14px;opacity:.75;margin-bottom:18px', text: message }),
      h('a', { class: 'btn btn-primary', href: `/api/file/${n.id}`, download: n.name }, icon('download'), '下载文件')
    );

  const show = (i) => {
    index = (i + previewable.length) % previewable.length;
    const n = previewable[index];
    renderHead(n);
    renderBody(n);
    prevBtn.classList.toggle('hidden', previewable.length < 2);
    nextBtn.classList.toggle('hidden', previewable.length < 2);
  };

  const prevBtn = h('button', { class: 'preview-nav prev', title: '上一个', onclick: () => show(index - 1) }, icon('arrow-left'));
  const nextBtn = h('button', { class: 'preview-nav next', title: '下一个', onclick: () => show(index + 1) }, icon('chevron-right'));

  overlay.append(head, body, prevBtn, nextBtn);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target === body) closePreview();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closePreview(); }
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  };
  document.addEventListener('keydown', onKey);

  current = {
    el: overlay,
    cleanup: () => document.removeEventListener('keydown', onKey),
  };
  document.body.append(overlay);
  show(index);
}

export function closePreview() {
  if (!current) return;
  current.cleanup();
  current.el.remove();
  current = null;
}

export function previewIsOpen() {
  return Boolean(current);
}
