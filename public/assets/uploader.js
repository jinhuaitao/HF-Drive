// 上传管理器：分片、并发、重试、断点续传
import { api } from './api.js';
import { h, icon, fmtBytes, toast } from './util.js';

export class Uploader {
  constructor({ getParent, onUploaded }) {
    this.getParent = getParent;
    this.onUploaded = onUploaded;
    this.tasks = [];
    this.folderCache = new Map();
    this.active = 0;
    // 并发度：同时传 3 个文件、每个文件 3 个分片并发。
    // HF 侧对 commit 有速率限制，Worker 内部已做 429/5xx 退避重试，这里失败也会重试。
    this.maxFiles = 3;
    this.chunkConcurrency = 3;
    this.panel = document.getElementById('upload-panel');
    this.dirty = false;
    this.lastNotify = 0;
  }

  /** 解析文件列表（含文件夹结构），返回 [{file, parent}] */
  async addFiles(fileList, parentOverride) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const baseParent = parentOverride || this.getParent();
    const prepared = [];

    for (const file of files) {
      const rel = file.webkitRelativePath || '';
      let parent = baseParent;
      if (rel) {
        const parts = rel.split('/');
        parts.pop();
        if (parts.length) parent = await this.ensurePath(baseParent, parts);
      }
      prepared.push({ file, parent });
    }

    for (const { file, parent } of prepared) {
      this.tasks.push({
        id: Math.random().toString(36).slice(2),
        file,
        name: file.name,
        size: file.size,
        parent,
        status: 'pending',
        progress: 0,
        chunksDone: 0,
        chunks: 0,
        error: null,
        uploadId: null,
        controller: null,
      });
    }
    this.render();
    this.pump();
  }

  async ensurePath(rootParent, parts) {
    let parent = rootParent;
    for (const part of parts) {
      const key = `${parent}/${part}`;
      if (this.folderCache.has(key)) {
        parent = this.folderCache.get(key);
        continue;
      }
      const res = await api.post('/folders', { name: part, parent, reuse: true });
      const id = res?.node?.id;
      if (!id) throw new Error('创建文件夹失败：' + part);
      this.folderCache.set(key, id);
      parent = id;
    }
    return parent;
  }

  pump() {
    const pending = this.tasks.filter((t) => t.status === 'pending');
    while (this.active < this.maxFiles && pending.length) {
      const task = pending.shift();
      this.runTask(task);
    }
    this.render();
  }

  async runTask(task) {
    this.active++;
    task.status = 'uploading';
    task.controller = new AbortController();
    this.render();
    let completed = false;
    try {
      const init = await api.post('/upload/init', {
        name: task.name,
        size: task.size,
        mime: task.file.type || '',
        parent: task.parent,
        resume: task.uploadId || undefined,
      });
      task.uploadId = init.uploadId;
      const { chunkSize, chunks } = init;
      task.chunks = chunks;
      const received = new Set(init.received || []);
      task.chunksDone = received.size;
      task.progress = chunks ? received.size / chunks : 0;
      this.render();

      const pendingChunks = [];
      for (let i = 0; i < chunks; i++) if (!received.has(i)) pendingChunks.push(i);
      let cursor = 0;

      const worker = async () => {
        while (cursor < pendingChunks.length) {
          if (task.status === 'canceled') throw new Error('已取消');
          const index = pendingChunks[cursor++];
          const start = index * chunkSize;
          const end = Math.min(task.size, start + chunkSize);
          const blob = task.file.slice(start, end);
          await this.retry(
            () => api.uploadChunk(task.uploadId, index, blob, task.controller.signal),
            task
          );
          task.chunksDone++;
          task.progress = chunks ? task.chunksDone / chunks : 1;
          this.render();
        }
      };

      const workers = Array.from(
        { length: Math.min(this.chunkConcurrency, Math.max(pendingChunks.length, 1)) },
        worker
      );
      await Promise.all(workers);
      if (task.status === 'canceled') throw new Error('已取消');

      await api.post('/upload/complete', { uploadId: task.uploadId });
      task.status = 'done';
      task.progress = 1;
      completed = true;
    } catch (err) {
      if (task.status === 'canceled' || err?.name === 'AbortError') {
        task.status = 'canceled';
        task.error = '已取消';
      } else {
        task.status = 'error';
        task.error = err?.message || '上传失败';
      }
    } finally {
      this.active--;
      this.render();
      if (completed) this.notifyUploaded();
      this.pump();
    }
  }

  async retry(fn, task) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (task.status === 'canceled') throw new Error('已取消');
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err?.name === 'AbortError') throw err;
        if (err?.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
        // 429（限流）等更久，其它错误短退避
        const base = err?.status === 429 ? 1500 : 500;
        await new Promise((r) => setTimeout(r, base * (attempt + 1) + Math.random() * 250));
      }
    }
    throw lastErr;
  }

  notifyUploaded() {
    const now = Date.now();
    if (now - this.lastNotify < 400) {
      clearTimeout(this._notifyTimer);
      this._notifyTimer = setTimeout(() => {
        this.lastNotify = Date.now();
        this.onUploaded?.();
      }, 400);
      return;
    }
    this.lastNotify = now;
    this.onUploaded?.();
  }

  cancelTask(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = 'canceled';
    task.controller?.abort();
    this.render();
  }

  retryTask(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = 'pending';
    task.error = null;
    task.progress = 0;
    this.render();
    this.pump();
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => t.status === 'uploading' || t.status === 'pending');
    this.render();
  }

  render() {
    if (!this.panel) return;
    const tasks = this.tasks;
    if (!tasks.length) {
      this.panel.classList.add('hidden');
      this.panel.innerHTML = '';
      return;
    }
    this.panel.classList.remove('hidden');

    const running = tasks.filter((t) => t.status === 'uploading' || t.status === 'pending').length;
    const doneCount = tasks.filter((t) => t.status === 'done').length;
    const failed = tasks.filter((t) => t.status === 'error').length;

    const head = h('div', { class: 'up-head' },
      icon('upload', 'sm'),
      h('span', { text: running ? `正在上传 ${running} 个文件` : `传输完成（${doneCount}）` }),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'icon-btn', title: '清除已完成',
        onclick: () => this.clearFinished(),
      }, icon('x'))
    );

    const list = h('div', { class: 'up-list' });
    for (const task of tasks.slice(-40)) {
      const pct = Math.round((task.progress || 0) * 100);
      const statusText =
        task.status === 'done' ? '已完成'
        : task.status === 'error' ? '失败'
        : task.status === 'canceled' ? '已取消'
        : task.status === 'pending' ? '等待中'
        : `${pct}%`;

      const bar = h('div', { class: 'up-bar' },
        h('i', {
          class: task.status === 'error' ? 'err' : task.status === 'done' ? 'ok' : '',
          style: `width:${task.status === 'done' ? 100 : pct}%`,
        })
      );

      const actions = h('div', { style: 'display:flex;gap:4px;align-items:center' });
      if (task.status === 'error' || task.status === 'canceled') {
        actions.append(
          h('button', { class: 'icon-btn', style: 'width:22px;height:22px', title: '重试', onclick: () => this.retryTask(task.id) }, icon('refresh', 'sm')),
          h('button', { class: 'icon-btn', style: 'width:22px;height:22px', title: '移除', onclick: () => { this.tasks = this.tasks.filter((t) => t.id !== task.id); this.render(); } }, icon('x', 'sm'))
        );
      } else if (task.status === 'uploading' || task.status === 'pending') {
        actions.append(
          h('button', { class: 'icon-btn', style: 'width:22px;height:22px', title: '取消', onclick: () => this.cancelTask(task.id) }, icon('x', 'sm'))
        );
      }

      list.append(
        h('div', { class: 'up-item' },
          h('div', { class: 'up-row' },
            h('span', { class: 'up-name', title: task.name, text: task.name }),
            h('span', {
              class: `up-status ${task.status === 'error' ? 'err' : task.status === 'done' ? 'ok' : ''}`,
              text: statusText,
            }),
            actions
          ),
          bar,
          h('div', { class: 'up-mini' },
            h('span', {
              text: task.status === 'error' ? task.error : `${fmtBytes(Math.round(task.size * (task.progress || 0)))} / ${fmtBytes(task.size)}`,
            }),
            h('span', { text: task.chunks ? `${task.chunksDone}/${task.chunks} 分片` : '' })
          )
        )
      );
    }

    this.panel.replaceChildren(head, list);
  }
}
