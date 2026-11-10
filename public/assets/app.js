// HF Drive —— 主应用
import { api, setUnauthorizedHandler, ApiError } from './api.js';
import * as U from './util.js';
import { Uploader } from './uploader.js';
import { openPreview, previewIsOpen } from './preview.js';

const { h, icon, fmtBytes, fmtTime, fmtTimeFull, toast, fileKind, fileIcon, openModal, confirmDialog, promptDialog, copyText, debounce, $ } = U;

const state = {
  view: 'files',
  parent: 'root',
  items: [],
  breadcrumb: [],
  stats: null,
  q: '',
  sort: { key: 'name', dir: 1 },
  mode: 'list',
  selected: new Set(),
  lastClicked: null,
  loading: false,
  user: null,
  storage: null,
  shares: [],
  version: '',
};

let uploader = null;

/* ================================================================ 启动 */

boot();

async function boot() {
  applyTheme();
  if (location.pathname.startsWith('/s/')) {
    const token = location.pathname.slice(3).split('/')[0];
    return renderPublicShare(token);
  }
  setUnauthorizedHandler(() => {
    if ($('#auth').classList.contains('hidden')) {
      showLogin('登录状态已失效，请重新登录');
    }
  });

  try {
    const st = await api.get('/state');
    state.version = st.version;
    if (st.needsSetup) return showSetup();
    if (!st.authed) return showLogin();
    state.user = st.user;
    state.storage = st.storage;
    startApp();
  } catch (err) {
    $('#boot').innerHTML = '';
    $('#boot').append(
      h('div', { class: 'boot-inner' },
        h('div', { class: 'empty-ico', style: 'margin:0 auto 16px' }, icon('cloud')),
        h('p', { style: 'color:var(--text);font-weight:600;margin:0 0 6px', text: '无法连接到服务' }),
        h('p', { style: 'font-size:12.5px;margin:0 0 18px', text: err.message }),
        h('button', { class: 'btn', onclick: () => location.reload(), text: '重新加载' })
      )
    );
  }
}

/* ================================================================ 认证界面 */

function authShell(inner) {
  $('#boot').classList.add('hidden');
  $('#app').classList.add('hidden');
  const root = $('#auth');
  root.classList.remove('hidden');
  root.replaceChildren(h('div', { class: 'auth-card' }, inner));
}

function authLogo() {
  return h('div', { class: 'auth-logo' },
    h('svg', { viewBox: '0 0 32 32', html: '<path d="M8 12.5l8-4.5 8 4.5v8l-8 4.5-8-4.5z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M8 12.5l8 4.5 8-4.5M16 17v8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" opacity=".65"/>' })
  );
}

function showLogin(notice) {
  const errBox = h('div', { class: 'auth-err hidden' });
  const username = h('input', { class: 'input', placeholder: '用户名', autocomplete: 'username', value: '' });
  const password = h('input', { class: 'input', type: 'password', placeholder: '密码', autocomplete: 'current-password' });
  const submitBtn = h('button', { class: 'btn btn-primary', text: '登录' });

  const showErr = (msg) => {
    errBox.replaceChildren(icon('info', 'sm'), h('span', { text: msg }));
    errBox.classList.remove('hidden');
  };

  const submit = async () => {
    if (!username.value.trim() || !password.value) return showErr('请输入用户名和密码');
    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';
    errBox.classList.add('hidden');
    try {
      await api.post('/login', { username: username.value.trim(), password: password.value });
      const st = await api.get('/state');
      state.user = st.user;
      state.storage = st.storage;
      state.version = st.version;
      $('#auth').classList.add('hidden');
      startApp();
    } catch (err) {
      showErr(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    }
  };

  password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  username.addEventListener('keydown', (e) => { if (e.key === 'Enter') password.focus(); });
  submitBtn.addEventListener('click', submit);

  authShell([
    authLogo(),
    h('h1', { text: '登录 HF Drive' }),
    h('p', { class: 'sub', text: '你的文件存放在自己的 HuggingFace 私有仓库中' }),
    notice ? h('div', { class: 'auth-err' }, icon('info', 'sm'), h('span', { text: notice })) : null,
    errBox,
    h('div', { class: 'field' }, h('label', { text: '用户名' }), username),
    h('div', { class: 'field' }, h('label', { text: '密码' }), password),
    submitBtn,
    h('div', { class: 'auth-foot' }, '连续输错会被临时锁定，请勿暴力尝试'),
  ]);
  setTimeout(() => username.focus(), 100);
}

function showSetup() {
  const draft = { username: '', password: '', hfToken: '', repoName: 'hf-drive-storage' };
  let step = 1;
  const root = $('#auth');
  const errBox = h('div', { class: 'auth-err hidden' });
  const stepsBar = h('div', { class: 'auth-steps' }, h('div', { class: 'auth-step on' }), h('div', { class: 'auth-step' }));

  const showErr = (msg) => {
    errBox.replaceChildren(icon('info', 'sm'), h('span', { text: msg }));
    errBox.classList.remove('hidden');
    errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const render = () => {
    $('#boot').classList.add('hidden');
    root.classList.remove('hidden');
    stepsBar.replaceChildren(
      h('div', { class: `auth-step${step >= 1 ? ' on' : ''}` }),
      h('div', { class: `auth-step${step >= 2 ? ' on' : ''}` })
    );

    if (step === 1) {
      const username = h('input', { class: 'input', placeholder: '例如 admin', value: draft.username, autocomplete: 'username' });
      const password = h('input', { class: 'input', type: 'password', placeholder: '至少 8 位', autocomplete: 'new-password' });
      const confirm = h('input', { class: 'input', type: 'password', placeholder: '再次输入密码', autocomplete: 'new-password' });
      const next = h('button', { class: 'btn btn-primary', text: '下一步' });
      next.addEventListener('click', () => {
        errBox.classList.add('hidden');
        if (username.value.trim().length < 2) return showErr('用户名至少 2 个字符');
        if (password.value.length < 8) return showErr('密码至少 8 位');
        if (password.value !== confirm.value) return showErr('两次输入的密码不一致');
        draft.username = username.value.trim();
        draft.password = password.value;
        step = 2;
        render();
      });
      root.replaceChildren(h('div', { class: 'auth-card' },
        authLogo(),
        h('h1', { text: '初始化你的网盘' }),
        h('p', { class: 'sub', text: '第一次使用，先创建一个管理员账号（数据只保存在你自己的 Cloudflare 账号里）' }),
        stepsBar,
        errBox,
        h('div', { class: 'field' }, h('label', { text: '管理员用户名' }), username),
        h('div', { class: 'field' }, h('label', { text: '登录密码' }), password),
        h('div', { class: 'field' }, h('label', { text: '确认密码' }), confirm),
        next
      ));
      setTimeout(() => username.focus(), 100);
      return;
    }

    const token = h('input', { class: 'input', placeholder: 'hf_xxxxxxxxxxxxxxxxxxxx', value: draft.hfToken, autocomplete: 'new-password', spellcheck: 'false' });
    const repo = h('input', { class: 'input', value: draft.repoName, placeholder: 'hf-drive-storage' });
    const submit = h('button', { class: 'btn btn-primary', text: '创建并进入' });
    const back = h('button', { class: 'btn ghost', text: '上一步' });
    back.addEventListener('click', () => { step = 1; render(); });

    submit.addEventListener('click', async () => {
      errBox.classList.add('hidden');
      const tk = token.value.trim();
      if (!/^hf_/.test(tk)) return showErr('请填写以 hf_ 开头的 Access Token');
      submit.disabled = true;
      submit.textContent = '正在创建私有仓库…';
      try {
        await api.post('/setup', {
          username: draft.username,
          password: draft.password,
          hfToken: tk,
          repoName: repo.value.trim() || 'hf-drive-storage',
        });
        const st = await api.get('/state');
        state.user = st.user;
        state.storage = st.storage;
        state.version = st.version;
        root.classList.add('hidden');
        startApp();
      } catch (err) {
        showErr(err.message);
        submit.disabled = false;
        submit.textContent = '创建并进入';
      }
    });

    root.replaceChildren(h('div', { class: 'auth-card' },
      authLogo(),
      h('h1', { text: '连接 HuggingFace 存储' }),
      h('p', { class: 'sub', text: '文件内容会分片存进你的私有 Dataset 仓库，密钥只存在你自己的 R2 里' }),
      stepsBar,
      errBox,
      h('div', { class: 'field' },
        h('label', { text: 'Access Token' }),
        token,
        h('div', { class: 'hint', html: '需要一个有 <b>write</b> 权限的 Token：<a href="https://huggingface.co/settings/tokens/new?tokenType=write" target="_blank" rel="noopener noreferrer">点此创建</a>' })
      ),
      h('div', { class: 'field' },
        h('label', { text: '仓库名称（不存在会自动创建为私有仓库）' }),
        repo,
        h('div', { class: 'hint', text: '会自动创建为 private dataset，只有你自己的 Token 能读取' })
      ),
      h('div', { class: 'auth-row' }, back, submit),
      h('div', { class: 'auth-foot' }, '不会向任何第三方服务器发送你的文件')
    ));
    setTimeout(() => token.focus(), 100);
  };

  render();
}

/* ================================================================ 应用主框架 */

function startApp() {
  $('#boot').classList.add('hidden');
  $('#auth').classList.add('hidden');
  $('#share-root').classList.add('hidden');
  $('#app').classList.remove('hidden');

  uploader = new Uploader({
    getParent: () => (state.view === 'files' ? state.parent : 'root'),
    onUploaded: () => { if (state.view === 'files' || state.view === 'starred') refresh({ keepSelection: false }); },
  });

  wireEvents();
  updateThemeIcon();
  refresh();
}

function wireEvents() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    switchView(btn.dataset.view);
    closeSidebar();
  });

  $('#view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    localStorage.setItem('hfd-mode', state.mode);
    U.$$('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    renderContent();
  });

  state.mode = localStorage.getItem('hfd-mode') || 'list';
  U.$$('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));

  const search = $('#search');
  search.addEventListener('input', debounce(() => {
    state.q = search.value.trim();
    $('#search-clear').classList.toggle('hidden', !state.q);
    if (state.view !== 'files' && state.view !== 'search') {
      state.view = 'search';
    }
    refresh();
  }, 320));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; search.blur(); state.q = ''; $('#search-clear').classList.add('hidden'); switchView('files'); }
  });
  $('#search-clear').addEventListener('click', () => {
    search.value = '';
    state.q = '';
    $('#search-clear').classList.add('hidden');
    switchView('files');
  });

  $('#btn-refresh').addEventListener('click', () => refresh());
  $('#btn-upload-main').addEventListener('click', () => $('#file-input').click());
  $('#btn-menu').addEventListener('click', openSidebar);
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);

  $('#file-input').addEventListener('change', (e) => {
    if (e.target.files?.length) uploader.addFiles(e.target.files);
    e.target.value = '';
  });
  $('#folder-input').addEventListener('change', (e) => {
    if (e.target.files?.length) uploader.addFiles(e.target.files);
    e.target.value = '';
  });

  U.$$('.foot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'theme') toggleTheme();
      else if (act === 'settings') switchView('settings');
      else if (act === 'logout') doLogout();
    });
  });

  document.addEventListener('keydown', onGlobalKey);
  wireDragDrop();
}

function onGlobalKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (previewIsOpen()) return;
    if (state.selected.size) { clearSelection(); return; }
    if (!typing && state.view === 'files' && state.parent !== 'root') goUp();
    return;
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.items.forEach((n) => state.selected.add(n.id));
    syncSelection();
    return;
  }
  if (e.key === 'Delete' || (e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
    if (state.selected.size) { e.preventDefault(); trashSelected(); }
    return;
  }
  if (e.key === 'F2' && state.selected.size === 1) {
    e.preventDefault();
    const id = [...state.selected][0];
    renameNode(state.items.find((n) => n.id === id));
    return;
  }
  if (e.key === 'Backspace' && state.view === 'files' && state.parent !== 'root') {
    e.preventDefault();
    goUp();
  }
}

/* ================================================================ 数据加载 */

async function refresh({ keepSelection = false } = {}) {
  if (!keepSelection) state.selected.clear();
  if (state.view === 'settings') {
    render();
    return;
  }
  state.loading = true;
  renderToolbar();
  if (!state.items.length) renderContent(true);

  try {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    else if (state.view === 'files') params.set('parent', state.parent);
    else params.set('view', state.view);

    const data = await api.get('/files?' + params.toString());
    state.items = data.items || [];
    state.breadcrumb = data.breadcrumb || [];
    state.stats = data.stats || state.stats;
    if (data.view) state.view = data.view;
    if (state.view === 'files' && data.parent) state.parent = data.parent;
    state.loading = false;
    render();
  } catch (err) {
    state.loading = false;
    if (err.status === 401) return;
    toast(err.message, 'err');
    renderContent(true, err.message);
  }
}

async function switchView(view) {
  state.view = view;
  state.q = '';
  state.selected.clear();
  $('#search').value = '';
  $('#search-clear').classList.add('hidden');
  if (view === 'files') state.parent = 'root';
  U.$$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'shares') {
    await loadShares();
    render();
    return;
  }
  state.items = [];
  render();
  await refresh();
}

async function loadShares() {
  try {
    const data = await api.get('/shares');
    state.shares = data.shares || [];
  } catch (err) {
    toast(err.message, 'err');
  }
}

function goUp() {
  const crumb = state.breadcrumb;
  if (crumb.length < 2) return;
  state.parent = crumb[crumb.length - 2].id;
  state.selected.clear();
  refresh();
}

function enterFolder(id) {
  state.view = 'files';
  state.parent = id;
  state.q = '';
  $('#search').value = '';
  $('#search-clear').classList.add('hidden');
  U.$$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'files'));
  state.items = [];
  refresh();
}

/* ================================================================ 渲染 */

function render() {
  renderCrumbs();
  renderToolbar();
  renderContent();
  renderStorage();
}

function renderCrumbs() {
  const wrap = $('#crumbs');
  wrap.replaceChildren();
  if (state.view === 'files') {
    state.breadcrumb.forEach((crumb, i) => {
      if (i > 0) wrap.append(h('span', { class: 'crumb-sep' }, icon('chevron-right')));
      const last = i === state.breadcrumb.length - 1;
      wrap.append(
        h('button', {
          class: 'crumb' + (last ? ' last' : ''),
          onclick: () => { if (!last) enterFolder(crumb.id); },
          title: crumb.name,
        }, i === 0 ? icon('home', 'sm') : null, h('span', { text: crumb.name }))
      );
    });
    if (!state.breadcrumb.length) wrap.append(h('span', { class: 'crumb last', text: '全部文件' }));
    return;
  }
  if (state.view === 'search') {
    wrap.append(h('button', { class: 'crumb', onclick: () => switchView('files') }, icon('arrow-left', 'sm'), h('span', { text: '返回文件' })));
    wrap.append(h('span', { class: 'crumb-sep' }, icon('chevron-right')));
    wrap.append(h('span', { class: 'crumb last', text: `搜索「${state.q}」` }));
    return;
  }
  const titles = { starred: '收藏', trash: '回收站', shares: '分享链接', settings: '设置' };
  wrap.append(h('span', { class: 'crumb last' }, icon(state.view === 'trash' ? 'trash' : state.view === 'starred' ? 'star' : state.view === 'shares' ? 'share' : 'settings', 'sm'), h('span', { text: titles[state.view] || '' })));
}

function renderToolbar() {
  const bar = $('#toolbar');
  bar.replaceChildren();
  fillToolbar(bar);
  bar.classList.toggle('empty', bar.children.length === 0);
}

function fillToolbar(bar) {
  const add = (...els) => els.forEach((e) => e && bar.append(e));
  if (state.selected.size > 0) {
    add(
      h('div', { class: 'sel-info' },
        h('span', { text: '已选择 ' }),
        h('b', { text: String(state.selected.size) }),
        h('span', { text: ' 项' })
      ),
      h('div', { style: 'width:8px' }),
      h('button', { class: 'btn sm ghost', onclick: clearSelection, text: '取消选择' })
    );
    const acts = h('div', { class: 'sel-actions', style: 'margin-left:auto' });
    if (state.view === 'trash') {
      acts.append(
        h('button', { class: 'btn sm', title: '还原', onclick: restoreSelected }, icon('restore'), h('span', { text: '还原' })),
        h('button', { class: 'btn sm btn-danger', title: '彻底删除', onclick: purgeSelected }, icon('trash'), h('span', { text: '彻底删除' }))
      );
    } else {
      acts.append(
        h('button', { class: 'btn sm', title: '下载', onclick: downloadSelected }, icon('download'), h('span', { text: '下载' })),
        h('button', { class: 'btn sm', title: '移动', onclick: () => moveSelected('move') }, icon('move'), h('span', { text: '移动' })),
        h('button', { class: 'btn sm', title: '复制', onclick: () => moveSelected('copy') }, icon('copy'), h('span', { text: '复制' })),
        h('button', { class: 'btn sm', title: '分享', onclick: shareSelected }, icon('share'), h('span', { text: '分享' })),
        h('button', { class: 'btn sm', title: '收藏', onclick: starSelected }, icon('star'), h('span', { text: state.items.filter((n) => state.selected.has(n.id)).every((n) => n.starred) ? '取消收藏' : '收藏' })),
        h('button', { class: 'btn sm btn-danger', title: '删除', onclick: trashSelected }, icon('trash'), h('span', { text: '删除' }))
      );
    }
    bar.append(acts);
    return;
  }

  if (state.view === 'files') {
    add(
      h('button', { class: 'btn btn-primary sm', title: '上传文件', onclick: () => $('#file-input').click() }, icon('upload'), h('span', { text: '上传文件' })),
      h('button', { class: 'btn sm', title: '上传文件夹', onclick: () => $('#folder-input').click() }, icon('folder-plus'), h('span', { text: '上传文件夹' })),
      h('button', { class: 'btn sm', title: '新建文件夹', onclick: newFolder }, icon('plus'), h('span', { text: '新建文件夹' }))
    );
    bar.append(h('div', { class: 'spacer' }));
    bar.append(sortSelect());
    return;
  }

  if (state.view === 'trash') {
    add(h('span', { class: 'sel-info', text: state.items.length ? `回收站里有 ${state.items.length} 项` : '回收站是空的' }));
    bar.append(h('div', { class: 'spacer' }));
    add(h('button', { class: 'btn sm btn-danger', title: '清空回收站', onclick: emptyTrash }, icon('trash'), h('span', { text: '清空回收站' })));
    return;
  }

  if (state.view === 'starred') {
    add(h('span', { class: 'sel-info', text: `${state.items.length} 个收藏项` }));
    bar.append(h('div', { class: 'spacer' }));
    add(sortSelect());
    return;
  }

  if (state.view === 'shares') {
    add(h('span', { class: 'sel-info', text: `${state.shares.length} 个分享链接` }));
    bar.append(h('div', { class: 'spacer' }));
    add(h('button', { class: 'btn sm', title: '刷新', onclick: async () => { await loadShares(); render(); } }, icon('refresh'), h('span', { text: '刷新' })));
    return;
  }

  if (state.view === 'search') {
    add(h('span', { class: 'sel-info', text: `找到 ${state.items.length} 个结果` }));
    bar.append(h('div', { class: 'spacer' }));
    add(sortSelect());
    return;
  }
}

function sortSelect() {
  const options = [
    ['name', '名称'],
    ['updatedAt', '修改时间'],
    ['size', '大小'],
    ['type', '类型'],
  ];
  const sel = h('select', { class: 'sort-select', title: '排序方式' });
  for (const [key, label] of options) {
    const opt = h('option', { value: key, text: label + (state.sort.key === key ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : '') });
    if (state.sort.key === key) opt.selected = true;
    sel.append(opt);
  }
  sel.append(h('option', { value: '__toggle', text: state.sort.dir > 0 ? '↑ 升序（点击切换）' : '↓ 降序（点击切换）' }));
  sel.addEventListener('change', () => {
    if (sel.value === '__toggle') state.sort.dir *= -1;
    else state.sort.key = sel.value;
    renderToolbar();
    renderContent();
  });
  return h('div', { style: 'display:flex;gap:6px;align-items:center' },
    icon('sort', 'sm'),
    sel
  );
}

function sortedItems() {
  const items = [...state.items];
  const { key, dir } = state.sort;
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let cmp = 0;
    if (key === 'name') cmp = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    else if (key === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (key === 'updatedAt') cmp = (a.updatedAt || 0) - (b.updatedAt || 0);
    else if (key === 'type') cmp = String(fileKind(a.name, a.mime)).localeCompare(String(fileKind(b.name, b.mime))) || a.name.localeCompare(b.name, 'zh-CN');
    return cmp * dir;
  });
  return items;
}

function renderContent(loadingOnly = false, errorMsg) {
  const box = $('#content-inner');
  if (loadingOnly || state.loading) {
    box.replaceChildren(skeleton());
    return;
  }
  if (errorMsg) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon('info')),
      h('h3', { text: '加载失败' }),
      h('p', { text: errorMsg }),
      h('button', { class: 'btn', onclick: () => refresh(), text: '重试' })
    ));
    return;
  }
  if (state.view === 'shares') return renderShares(box);
  if (state.view === 'settings') return renderSettings(box);

  const items = sortedItems();
  if (!items.length) return box.replaceChildren(emptyState());

  box.replaceChildren(state.mode === 'grid' ? renderGrid(items) : renderList(items));
}

function skeleton() {
  const wrap = h('div', { class: 'file-table' });
  for (let i = 0; i < 7; i++) {
    wrap.append(h('div', { class: 'ft-row', style: 'opacity:.5' },
      h('div', { class: 'ft-cell c-check' }, h('div', { style: 'width:17px;height:17px;border-radius:5px;background:var(--surface-3)' })),
      h('div', { class: 'ft-cell c-name' },
        h('div', { style: 'width:34px;height:34px;border-radius:9px;background:var(--surface-3)' }),
        h('div', { style: `height:11px;border-radius:6px;background:var(--surface-3);width:${120 + (i * 37) % 180}px` })
      ),
      h('div', { class: 'ft-cell c-size' }, h('div', { style: 'height:11px;width:44px;border-radius:6px;background:var(--surface-3)' })),
      h('div', { class: 'ft-cell c-time' }, h('div', { style: 'height:11px;width:80px;border-radius:6px;background:var(--surface-3)' })),
      h('div', { class: 'ft-cell' })
    ));
  }
  return wrap;
}

function emptyState() {
  if (state.view === 'search') {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon('search')),
      h('h3', { text: '没有找到匹配的文件' }),
      h('p', { text: `没有名称包含「${state.q}」的文件，换个关键词试试` }),
      h('button', { class: 'btn', onclick: () => switchView('files'), text: '返回全部文件' })
    );
  }
  if (state.view === 'trash') {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon('trash')),
      h('h3', { text: '回收站是空的' }),
      h('p', { text: '删除的文件会先放到这里，确认后再彻底删除' })
    );
  }
  if (state.view === 'starred') {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon('star')),
      h('h3', { text: '还没有收藏' }),
      h('p', { text: '在文件上右键选择「收藏」，重要文件就能快速找到' })
    );
  }
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-ico' }, icon('folder')),
    h('h3', { text: '这里还没有文件' }),
    h('p', { text: '把文件拖进来，或者点击下方按钮上传' }),
    h('div', { style: 'display:flex;gap:8px' },
      h('button', { class: 'btn btn-primary', onclick: () => $('#file-input').click() }, icon('upload'), '上传文件'),
      h('button', { class: 'btn', onclick: newFolder }, icon('plus'), '新建文件夹')
    )
  );
}

function renderList(items) {
  const table = h('div', { class: 'file-table' });
  const allChecked = items.length > 0 && items.every((n) => state.selected.has(n.id));
  const someChecked = items.some((n) => state.selected.has(n.id));
  const headCheck = h('input', { type: 'checkbox', checked: allChecked });
  headCheck.indeterminate = !allChecked && someChecked;
  headCheck.addEventListener('change', () => {
    if (headCheck.checked) items.forEach((n) => state.selected.add(n.id));
    else items.forEach((n) => state.selected.delete(n.id));
    syncSelection();
  });

  const head = h('div', { class: 'ft-head' },
    h('div', { class: 'ft-cell c-check' }, headCheck),
    h('div', { class: 'ft-cell c-name' }, h('span', { class: 'sortable', onclick: () => setSort('name') }, '名称', sortArrow('name'))),
    h('div', { class: 'ft-cell c-size' }, h('span', { class: 'sortable', onclick: () => setSort('size') }, '大小', sortArrow('size'))),
    h('div', { class: 'ft-cell c-time' }, h('span', { class: 'sortable', onclick: () => setSort('updatedAt') }, '修改时间', sortArrow('updatedAt'))),
    h('div', { class: 'ft-cell c-actions' })
  );
  table.append(head);

  for (const node of items) table.append(rowFor(node));
  return table;
}

function sortArrow(key) {
  if (state.sort.key !== key) return null;
  return h('span', { style: 'font-size:10px', text: state.sort.dir > 0 ? '▲' : '▼' });
}

function setSort(key) {
  if (state.sort.key === key) state.sort.dir *= -1;
  else { state.sort.key = key; state.sort.dir = 1; }
  renderToolbar();
  renderContent();
}

function rowFor(node) {
  const kind = node.type === 'folder' ? 'folder' : fileKind(node.name, node.mime);
  const selected = state.selected.has(node.id);
  const row = h('div', {
    class: 'ft-row' + (selected ? ' selected' : ''),
    dataset: { id: node.id },
    draggable: 'true',
  });

  const check = h('input', { type: 'checkbox', checked: selected });
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelect(node.id, e.shiftKey);
  });

  const thumb = node.type === 'file' && kind === 'image' && node.size < 4 * 1024 * 1024
    ? h('img', { class: 'thumb', src: `/api/file/${node.id}?inline=1`, loading: 'lazy', decoding: 'async', fetchpriority: 'low', alt: '' })
    : fileIcon(kind);

  const nameEl = h('div', { class: 'file-name' },
    h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: node.name }),
    node.starred ? h('span', { class: 'tag', text: '收藏' }) : null,
    node.recovered ? h('span', { class: 'tag', text: '已恢复' }) : null
  );

  row.append(
    h('div', { class: 'ft-cell c-check' }, check),
    h('div', { class: 'ft-cell c-name' }, thumb, h('div', { style: 'min-width:0;flex:1' },
      nameEl,
      state.view === 'search' || state.view === 'trash' || state.view === 'starred'
        ? h('div', { style: 'font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: node.path || '' })
        : null
    )),
    h('div', { class: 'ft-cell c-size', text: node.type === 'folder' ? '—' : fmtBytes(node.size) }),
    h('div', { class: 'ft-cell c-time', text: fmtTime(state.view === 'trash' ? node.trashedAt : node.updatedAt) }),
    h('div', { class: 'ft-cell c-actions' },
      state.view === 'trash'
        ? h('button', { class: 'icon-btn', title: '还原', onclick: (e) => { e.stopPropagation(); restoreNodes([node.id]); } }, icon('restore', 'sm'))
        : h('button', { class: 'icon-btn', title: '更多', onclick: (e) => { e.stopPropagation(); showContextMenu(e, node); } }, icon('more', 'sm'))
    )
  );

  row.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
    toggleSelect(node.id, e.shiftKey, e.metaKey || e.ctrlKey);
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
    openNode(node);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!state.selected.has(node.id)) selectOnly(node.id);
    showContextMenu(e, node);
  });
  wireRowDrag(row, node);
  return row;
}

function renderGrid(items) {
  const grid = h('div', { class: 'file-grid' });
  for (const node of items) {
    const kind = node.type === 'folder' ? 'folder' : fileKind(node.name, node.mime);
    const selected = state.selected.has(node.id);
    const thumbBox = h('div', { class: 'fg-thumb' });
    if (node.type === 'file' && kind === 'image' && node.size < 4 * 1024 * 1024) {
      thumbBox.append(h('img', { src: `/api/file/${node.id}?inline=1`, loading: 'lazy', decoding: 'async', fetchpriority: 'low', alt: '' }));
    } else {
      thumbBox.append(fileIcon(kind));
    }
    const check = h('input', { type: 'checkbox', checked: selected });
    check.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(node.id, e.shiftKey); });

    const card = h('div', { class: 'fg-card' + (selected ? ' selected' : ''), dataset: { id: node.id }, draggable: 'true' },
      thumbBox,
      h('div', { class: 'fg-check' }, check),
      h('button', { class: 'fg-more', title: '更多', onclick: (e) => { e.stopPropagation(); showContextMenu(e, node); } }, icon('more', 'sm')),
      h('div', { class: 'fg-meta' },
        h('div', { class: 'fg-name', title: node.name, text: node.name }),
        h('div', { class: 'fg-sub' },
          h('span', { text: node.type === 'folder' ? '文件夹' : fmtBytes(node.size) }),
          h('span', { text: '·' }),
          h('span', { text: fmtTime(node.updatedAt) })
        )
      )
    );
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
      toggleSelect(node.id, e.shiftKey, e.metaKey || e.ctrlKey);
    });
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
      openNode(node);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.selected.has(node.id)) selectOnly(node.id);
      showContextMenu(e, node);
    });
    wireRowDrag(card, node);
    grid.append(card);
  }
  return grid;
}

function renderStorage() {
  const stats = state.stats;
  if (!stats) return;
  const total = stats.total || 0;
  const used = stats.used || 0;
  const trash = stats.trash || 0;
  const usedPct = total ? (used / total) * 100 : 0;
  const trashPct = total ? (trash / total) * 100 : 0;
  $('#storage-pct').textContent = fmtBytes(total);
  $('#storage-fill').style.width = usedPct + '%';
  const trashBar = $('#storage-trash');
  if (trashBar) trashBar.style.width = trashPct + '%';
  $('#storage-text').textContent = total
    ? `文件 ${fmtBytes(used)} · 回收站 ${fmtBytes(trash)}`
    : '还没有占用空间';
  const sub = $('#brand-sub');
  if (sub && state.storage?.repo) sub.textContent = state.storage.repo;
}

/* ================================================================ 选择 */

function toggleSelect(id, shift = false, additive = true) {
  if (shift && state.lastClicked) {
    const items = sortedItems();
    const a = items.findIndex((n) => n.id === state.lastClicked);
    const b = items.findIndex((n) => n.id === id);
    if (a !== -1 && b !== -1) {
      const [from, to] = a < b ? [a, b] : [b, a];
      for (let i = from; i <= to; i++) state.selected.add(items[i].id);
      state.lastClicked = id;
      syncSelection();
      return;
    }
  }
  if (!additive) {
    state.selected.clear();
    state.selected.add(id);
  } else if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    state.selected.add(id);
  }
  state.lastClicked = id;
  syncSelection();
}

function selectOnly(id) {
  state.selected.clear();
  state.selected.add(id);
  state.lastClicked = id;
  syncSelection();
}

function clearSelection() {
  state.selected.clear();
  syncSelection();
}

/**
 * 只同步选中态：改 class 和 checkbox，不重建 DOM。
 * 之前每次点选都 renderContent()，等于把整个列表（含图片）重新创建一遍，
 * 百来个文件时点击会有明显延迟、缩略图还会闪。
 */
function syncSelection() {
  const rows = document.querySelectorAll('#content-inner .ft-row, #content-inner .fg-card');
  for (const el of rows) {
    const on = state.selected.has(el.dataset.id);
    el.classList.toggle('selected', on);
    const cb = el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = on;
  }
  const headCb = document.querySelector('.ft-head input[type="checkbox"]');
  if (headCb) {
    const n = state.items.reduce((acc, it) => acc + (state.selected.has(it.id) ? 1 : 0), 0);
    headCb.checked = n > 0 && n === state.items.length;
    headCb.indeterminate = n > 0 && n < state.items.length;
  }
  renderToolbar();
}

function selectedNodes() {
  return state.items.filter((n) => state.selected.has(n.id));
}

/* ================================================================ 操作 */

function openNode(node) {
  if (node.type === 'folder') enterFolder(node.id);
  else openPreview(node, sortedItems());
}

async function newFolder() {
  const name = await promptDialog({
    title: '新建文件夹',
    label: '文件夹名称',
    value: '新建文件夹',
    okText: '创建',
  });
  if (!name) return;
  try {
    await api.post('/folders', { name, parent: state.view === 'files' ? state.parent : 'root' });
    toast('文件夹已创建', 'ok');
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function renameNode(node) {
  if (!node) return;
  const name = await promptDialog({ title: '重命名', label: '新名称', value: node.name, okText: '保存' });
  if (!name || name === node.name) return;
  try {
    await api.patch(`/nodes/${node.id}`, { name });
    toast('已重命名', 'ok');
    refresh({ keepSelection: true });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function trashSelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const ok = await confirmDialog({
    title: '移到回收站',
    message: `确定把选中的 ${nodes.length} 项移到回收站吗？之后可以在回收站里还原。`,
    okText: '移到回收站',
    danger: true,
  });
  if (!ok) return;
  await trashNodes(nodes.map((n) => n.id));
}

async function trashNodes(ids) {
  try {
    await api.post('/nodes/delete', { ids });
    toast('已移到回收站', 'ok');
    clearSelection();
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function restoreSelected() {
  await restoreNodes([...state.selected]);
}

async function restoreNodes(ids) {
  try {
    await api.post('/nodes/restore', { ids });
    toast('已还原', 'ok');
    clearSelection();
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function purgeSelected() {
  const ids = [...state.selected];
  const ok = await confirmDialog({
    title: '彻底删除',
    message: `将从 HuggingFace 仓库中永久删除 ${ids.length} 项及其所有分片，无法恢复。`,
    okText: '永久删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post('/nodes/purge', { ids });
    toast('已永久删除', 'ok');
    clearSelection();
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function emptyTrash() {
  const ok = await confirmDialog({
    title: '清空回收站',
    message: '回收站里的所有文件都会被永久删除，包括 HuggingFace 仓库中的分片数据，无法恢复。',
    okText: '清空回收站',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.post('/trash/empty', {});
    toast(`已清理 ${res.removed} 项`, 'ok');
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function downloadSelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  if (nodes.length === 1 && nodes[0].type === 'file') {
    window.location.href = `/api/file/${nodes[0].id}`;
    return;
  }
  const ids = nodes.map((n) => n.id).join(',');
  window.location.href = `/api/zip?ids=${encodeURIComponent(ids)}`;
}

function shareSelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  if (nodes.length > 1) return toast('一次只能分享一个文件或文件夹', 'err');
  openShareModal(nodes[0]);
}

async function starSelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const allStarred = nodes.every((n) => n.starred);
  try {
    await Promise.all(nodes.map((n) => api.patch(`/nodes/${n.id}`, { starred: !allStarred })));
    toast(allStarred ? '已取消收藏' : '已加入收藏', 'ok');
    refresh({ keepSelection: true });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function moveSelected(mode) {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const exclude = nodes.filter((n) => n.type === 'folder').map((n) => n.id);
  const target = await openFolderPicker({
    title: mode === 'move' ? '移动到…' : '复制到…',
    okText: mode === 'move' ? '移动到这里' : '复制到这里',
    excludeIds: exclude,
  });
  if (!target) return;
  try {
    if (mode === 'move') {
      await Promise.all(nodes.map((n) => api.patch(`/nodes/${n.id}`, { parent: target })));
      toast('已移动', 'ok');
    } else {
      toast('正在复制，请稍候…', 'info');
      await api.post('/nodes/copy', { ids: nodes.map((n) => n.id), parent: target });
      toast('复制完成', 'ok');
    }
    clearSelection();
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ================================================================ 右键菜单 */

let ctxEl = null;
function closeContextMenu() {
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}

function showContextMenu(event, node) {
  closeContextMenu();
  const e = event.touches?.[0] || event;
  const menu = h('div', { class: 'ctx-menu' });
  const addItem = (label, iconName, fn, danger = false) => {
    menu.append(h('button', {
      class: 'ctx-item' + (danger ? ' danger' : ''),
      onclick: (ev) => { ev.stopPropagation(); closeContextMenu(); fn(); },
    }, icon(iconName, 'sm'), h('span', { text: label })));
  };
  const addSep = () => menu.append(h('div', { class: 'ctx-sep' }));

  if (state.view === 'trash') {
    addItem('还原', 'restore', () => restoreNodes([node.id]));
    addItem('彻底删除', 'trash', async () => {
      const ok = await confirmDialog({ title: '彻底删除', message: `永久删除「${node.name}」？`, okText: '永久删除', danger: true });
      if (!ok) return;
      await api.post('/nodes/purge', { ids: [node.id] }).then(() => { toast('已删除', 'ok'); refresh(); }).catch((err) => toast(err.message, 'err'));
    }, true);
  } else {
    addItem(node.type === 'folder' ? '打开' : '预览', node.type === 'folder' ? 'folder' : 'eye', () => openNode(node));
    addItem('下载', 'download', () => {
      window.location.href = node.type === 'folder' ? `/api/zip?ids=${node.id}` : `/api/file/${node.id}`;
    });
    addSep();
    addItem('重命名', 'pencil', () => renameNode(node));
    addItem('移动到…', 'move', () => moveSelected('move'));
    addItem('复制到…', 'copy', () => moveSelected('copy'));
    addItem(node.starred ? '取消收藏' : '收藏', 'star', async () => {
      try {
        await api.patch(`/nodes/${node.id}`, { starred: !node.starred });
        refresh({ keepSelection: true });
      } catch (err) { toast(err.message, 'err'); }
    });
    addSep();
    addItem('分享链接', 'share', () => openShareModal(node));
    addItem('详细信息', 'info', () => showDetails(node));
    addSep();
    addItem('移到回收站', 'trash', () => trashNodes([node.id]), true);
  }

  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  menu.style.visibility = '';
  ctxEl = menu;

  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('scroll', closeContextMenu, { once: true, capture: true });
  }, 0);
}

function showDetails(node) {
  const rows = [
    ['名称', node.name],
    ['类型', node.type === 'folder' ? '文件夹' : (node.mime || U.extOf(node.name) || '未知')],
    ['大小', node.type === 'folder' ? '—' : `${fmtBytes(node.size)}（${node.size.toLocaleString()} 字节）`],
    ['分片', node.type === 'folder' ? '—' : `${node.chunks} 片 × ${fmtBytes(8 * 1024 * 1024)}`],
    ['创建时间', fmtTimeFull(node.createdAt)],
    ['修改时间', fmtTimeFull(node.updatedAt)],
    ['收藏', node.starred ? '是' : '否'],
  ];
  const ref = openModal({
    title: '详细信息',
    body: h('div', {}, rows.map(([k, v]) => h('div', { class: 'kv' }, h('span', { text: k }), h('span', { text: v })))),
    footer: [h('button', { class: 'btn', onclick: () => ref.close(), text: '关闭' })],
  });
}

/* ================================================================ 文件夹选择器 */

function openFolderPicker({ title, okText, excludeIds = [] }) {
  return new Promise((resolve) => {
    let currentId = 'root';
    let finished = false;
    const pathEl = h('div', { class: 'picker-path' });
    const listEl = h('div', { class: 'picker-list' });

    const finish = (v) => {
      if (finished) return;
      finished = true;
      ref.close();
      resolve(v);
    };

    const load = async (id) => {
      currentId = id;
      listEl.replaceChildren(h('div', { class: 'picker-empty', text: '加载中…' }));
      try {
        const data = await api.get('/files?parent=' + encodeURIComponent(id));
        const crumbs = data.breadcrumb || [];
        pathEl.replaceChildren(
          ...crumbs.map((c, i) => h('span', { style: 'display:flex;align-items:center;gap:6px' },
            i > 0 ? icon('chevron-right', 'sm') : icon('home', 'sm'),
            h('button', {
              style: 'border:none;background:none;padding:0;color:inherit;font:inherit',
              onclick: () => load(c.id),
              text: c.name,
            })
          ))
        );
        const folders = (data.items || []).filter((n) => n.type === 'folder' && !excludeIds.includes(n.id));
        if (!folders.length) {
          listEl.replaceChildren(h('div', { class: 'picker-empty', text: '当前目录没有子文件夹' }));
        } else {
          listEl.replaceChildren(...folders.map((f) =>
            h('button', { class: 'picker-item', onclick: () => load(f.id) }, icon('folder', 'sm'), h('span', { text: f.name }), h('span', { style: 'margin-left:auto;color:var(--muted)' }, icon('chevron-right', 'sm')))
          ));
        }
      } catch (err) {
        listEl.replaceChildren(h('div', { class: 'picker-empty', text: err.message }));
      }
    };

    const ref = openModal({
      title,
      subtitle: '选择目标文件夹',
      body: h('div', {}, pathEl, h('div', { class: 'picker', style: 'margin-top:8px' }, listEl)),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(null), text: '取消' }),
        h('button', { class: 'btn btn-primary', onclick: () => finish(currentId), text: okText }),
      ],
      onClose: () => finish(null),
    });
    load('root');
  });
}

/* ================================================================ 分享 */

async function openShareModal(node) {
  const password = h('input', { class: 'input', placeholder: '留空则无需密码', autocomplete: 'new-password' });
  const expires = h('select', { class: 'input' },
    h('option', { value: '0', text: '永久有效' }),
    h('option', { value: '1', text: '1 小时' }),
    h('option', { value: '24', text: '1 天' }),
    h('option', { value: '168', text: '7 天' }),
    h('option', { value: '720', text: '30 天' })
  );
  const allowDownload = h('input', { type: 'checkbox', checked: true });
  const resultBox = h('div', { class: 'hidden', style: 'margin-top:14px' });

  const body = h('div', {},
    h('div', { class: 'opt-row' },
      h('div', {}, h('div', { class: 'opt-label', text: node.name }), h('div', { class: 'opt-desc', text: node.type === 'folder' ? '文件夹分享（可在线浏览）' : fmtBytes(node.size) }))
    ),
    h('div', { class: 'field' }, h('label', { text: '提取密码（可选）' }), password),
    h('div', { class: 'field' }, h('label', { text: '有效期' }), expires),
    h('div', { class: 'opt-row' },
      h('div', {}, h('div', { class: 'opt-label', text: '允许下载' }), h('div', { class: 'opt-desc', text: '关闭后只能在线预览' })),
      h('label', { class: 'switch' }, allowDownload, h('i'))
    ),
    resultBox
  );

  const createBtn = h('button', { class: 'btn btn-primary', text: '创建链接' });
  const ref = openModal({
    title: '创建分享链接',
    subtitle: '拿到链接的人可以在有效期内访问',
    body,
    footer: [h('button', { class: 'btn', onclick: () => ref.close(), text: '关闭' }), createBtn],
  });

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    createBtn.textContent = '创建中…';
    try {
      const res = await api.post('/shares', {
        nodeId: node.id,
        password: password.value.trim(),
        expiresIn: Number(expires.value),
        allowDownload: allowDownload.checked,
      });
      const url = res.share.url;
      const linkInput = h('input', { class: 'input', value: url, readonly: true });
      resultBox.classList.remove('hidden');
      resultBox.replaceChildren(
        h('div', { class: 'field', style: 'margin-top:16px' },
          h('label', { text: '分享链接' }),
          h('div', { class: 'share-link-row' },
            linkInput,
            h('button', {
              class: 'btn',
              onclick: async () => { await copyText(url); toast('链接已复制', 'ok'); },
            }, icon('copy', 'sm'), '复制')
          ),
          h('div', { class: 'hint', text: '任何拿到链接的人都能访问，请谨慎分享' })
        )
      );
      createBtn.classList.add('hidden');
    } catch (err) {
      toast(err.message, 'err');
      createBtn.disabled = false;
      createBtn.textContent = '创建链接';
    }
  });
}

function renderShares(box) {
  if (!state.shares.length) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon('share')),
      h('h3', { text: '还没有分享链接' }),
      h('p', { text: '在文件上右键选择「分享链接」，即可生成一个可访问的地址' })
    ));
    return;
  }
  const wrap = h('div', {});
  for (const s of state.shares) {
    const url = s.url;
    wrap.append(h('div', { class: 'share-item' },
      fileIcon(s.isFolder ? 'folder' : fileKind(s.name)),
      h('div', { class: 'share-main' },
        h('div', { class: 'share-title' },
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: s.name }),
          s.hasPassword ? h('span', { class: 'badge', text: '密码' }) : null,
          s.expired ? h('span', { class: 'badge warn', text: '已过期' }) : null,
          s.missing ? h('span', { class: 'badge warn', text: '文件已删除' }) : null
        ),
        h('div', { class: 'share-meta' },
          h('span', { text: `创建于 ${fmtTime(s.createdAt)}` }),
          h('span', { text: s.expiresAt ? `${fmtTime(s.expiresAt)} 过期` : '永久有效' }),
          h('span', { text: `${s.views || 0} 次访问` })
        )
      ),
      h('div', { class: 'share-actions' },
        h('button', { class: 'icon-btn', title: '复制链接', onclick: async () => { await copyText(url); toast('已复制', 'ok'); } }, icon('copy', 'sm')),
        h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener noreferrer', title: '打开' }, icon('link', 'sm')),
        h('button', {
          class: 'icon-btn', title: '取消分享',
          onclick: async () => {
            const ok = await confirmDialog({ title: '取消分享', message: '删除后该链接立即失效。', okText: '取消分享', danger: true });
            if (!ok) return;
            try {
              await api.del(`/shares/${s.token}`);
              toast('已取消分享', 'ok');
              await loadShares();
              render();
            } catch (err) { toast(err.message, 'err'); }
          },
        }, icon('trash', 'sm'))
      )
    ));
  }
  box.replaceChildren(wrap);
}

/* ================================================================ 设置页 */

function renderSettings(box) {
  const wrap = h('div', { class: 'settings-wrap' });

  // 账户
  const newUser = h('input', { class: 'input', value: state.user || '' });
  const saveUser = h('button', { class: 'btn', text: '保存用户名' });
  saveUser.addEventListener('click', async () => {
    try {
      const res = await api.post('/settings/account', { username: newUser.value.trim() });
      state.user = res.username;
      toast('用户名已更新', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  const oldPwd = h('input', { class: 'input', type: 'password', placeholder: '当前密码', autocomplete: 'current-password' });
  const newPwd = h('input', { class: 'input', type: 'password', placeholder: '新密码（至少 8 位）', autocomplete: 'new-password' });
  const savePwd = h('button', { class: 'btn', text: '修改密码' });
  savePwd.addEventListener('click', async () => {
    if (newPwd.value.length < 8) return toast('新密码至少 8 位', 'err');
    savePwd.disabled = true;
    try {
      const res = await api.post('/settings/password', { oldPassword: oldPwd.value, newPassword: newPwd.value });
      toast(`密码已更新，已注销 ${res.loggedOutDevices} 个其它设备`, 'ok');
      oldPwd.value = '';
      newPwd.value = '';
    } catch (err) { toast(err.message, 'err'); }
    savePwd.disabled = false;
  });

  wrap.append(h('div', { class: 'settings-card' },
    h('h3', { text: '账户' }),
    h('p', { class: 'desc', text: '用于登录这个网盘的账号密码，与 HuggingFace 账号无关。' }),
    h('div', { class: 'field' }, h('label', { text: '用户名' }), h('div', { class: 'share-link-row' }, newUser, saveUser)),
    h('div', { class: 'field' }, h('label', { text: '修改密码' }), oldPwd),
    h('div', { class: 'field' }, newPwd),
    savePwd
  ));

  // 存储
  const token = h('input', { class: 'input', type: 'password', placeholder: '留空则不修改', autocomplete: 'new-password' });
  const repo = h('input', { class: 'input', value: state.storage?.repo?.split('/')?.[1] || '' });
  const saveStorage = h('button', { class: 'btn', text: '保存存储设置' });
  saveStorage.addEventListener('click', async () => {
    saveStorage.disabled = true;
    try {
      const res = await api.post('/settings/storage', { hfToken: token.value.trim(), repoName: repo.value.trim() });
      state.storage = { repo: res.repo, owner: res.owner };
      token.value = '';
      toast(res.changed ? '存储已切换（旧文件仍留在原仓库）' : '存储设置已保存', 'ok');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
    saveStorage.disabled = false;
  });

  const rebuild = h('button', { class: 'btn', text: '从仓库重建索引' });
  rebuild.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '重建索引',
      message: '扫描 HuggingFace 仓库里的所有分片，把索引中缺失的文件补回「全部文件」。用于灾难恢复，不会删除任何数据。',
      okText: '开始扫描',
    });
    if (!ok) return;
    rebuild.disabled = true;
    rebuild.textContent = '扫描中…';
    try {
      const res = await api.post('/settings/rebuild', {});
      toast(`扫描 ${res.scanned} 个分片，恢复 ${res.recovered} 个文件`, 'ok');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
    rebuild.disabled = false;
    rebuild.textContent = '从仓库重建索引';
  });

  wrap.append(h('div', { class: 'settings-card' },
    h('h3', { text: '存储' }),
    h('p', { class: 'desc', text: '文件内容以 8MB 分片存放在你的 HuggingFace 私有 Dataset 仓库中，密钥保存在 Cloudflare R2。' }),
    h('div', { class: 'kv' }, h('span', { text: '当前仓库' }), h('span', { class: 'mono', text: state.storage?.repo || '—' })),
    h('div', { class: 'kv' }, h('span', { text: '已用空间' }), h('span', { text: `${fmtBytes(state.stats?.used || 0)}${state.stats?.trash ? `（回收站另有 ${fmtBytes(state.stats.trash)}）` : ''}` })),
    h('div', { class: 'kv' }, h('span', { text: '文件 / 文件夹' }), h('span', { text: `${state.stats?.files || 0} / ${state.stats?.folders || 0}` })),
    h('div', { style: 'height:16px' }),
    h('div', { class: 'field' }, h('label', { text: '更换 Access Token' }), token),
    h('div', { class: 'field' }, h('label', { text: '仓库名称' }), repo),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, saveStorage, rebuild)
  ));

  // 关于
  wrap.append(h('div', { class: 'settings-card' },
    h('h3', { text: '关于' }),
    h('p', { class: 'desc', text: 'HF Drive 是一个自托管的网盘：前端跑在 Cloudflare Workers，文件存在你自己的 HuggingFace 私有仓库，元数据存在自动创建的 R2 存储桶。' }),
    h('div', { class: 'kv' }, h('span', { text: '版本' }), h('span', { text: state.version || '1.0.0' })),
    h('div', { class: 'kv' }, h('span', { text: '分片大小' }), h('span', { text: fmtBytes(8 * 1024 * 1024) })),
    h('div', { class: 'kv' }, h('span', { text: '回收站' }), h('span', { text: `${state.stats?.trash ? fmtBytes(state.stats.trash) : '空'}` })),
    h('div', { style: 'margin-top:16px;display:flex;gap:8px;flex-wrap:wrap' },
      h('a', { class: 'btn', href: 'https://huggingface.co/' + (state.storage?.repo || ''), target: '_blank', rel: 'noopener noreferrer' }, icon('link', 'sm'), '打开 HuggingFace 仓库'),
      h('button', { class: 'btn btn-danger', onclick: doLogout }, icon('logout', 'sm'), '退出登录')
    )
  ));

  box.replaceChildren(wrap);
}

/* ================================================================ 拖拽 */

function wireDragDrop() {
  const content = $('#content');
  const overlay = $('#drop-overlay');
  let dragDepth = 0;

  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  content.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth++;
    overlay.classList.remove('hidden');
  });
  content.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.classList.add('hidden');
  });
  content.addEventListener('dragover', (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
  content.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    if (state.view !== 'files') {
      toast('请先进入「全部文件」再拖入文件', 'err');
      return;
    }
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) uploader.addFiles(files, state.parent);
  });
}

async function collectDroppedFiles(dt) {
  const out = [];
  const items = Array.from(dt.items || []);
  const entries = items
    .map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) return Array.from(dt.files || []);

  const walk = (entry, path) =>
    new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file) => {
          Object.defineProperty(file, 'webkitRelativePath', { value: path ? `${path}/${file.name}` : file.name, configurable: true });
          out.push(file);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(async (batch) => {
            if (!batch.length) return resolve();
            for (const child of batch) await walk(child, path ? `${path}/${entry.name}` : entry.name);
            readAll();
          }, () => resolve());
        };
        readAll();
      } else resolve();
    });

  for (const entry of entries) await walk(entry, '');
  return out;
}

function wireRowDrag(el, node) {
  el.addEventListener('dragstart', (e) => {
    if (state.selected.has(node.id) && state.selected.size > 1) {
      e.dataTransfer.setData('application/x-hfd-ids', JSON.stringify([...state.selected]));
    } else {
      e.dataTransfer.setData('application/x-hfd-ids', JSON.stringify([node.id]));
    }
    e.dataTransfer.effectAllowed = 'move';
    el.style.opacity = '0.5';
  });
  el.addEventListener('dragend', () => { el.style.opacity = ''; });

  if (node.type !== 'folder') return;
  el.addEventListener('dragover', (e) => {
    const types = Array.from(e.dataTransfer.types || []);
    if (types.includes('application/x-hfd-ids') || types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop-target');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop-target');
    const raw = e.dataTransfer.getData('application/x-hfd-ids');
    if (raw) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const ids = JSON.parse(raw).filter((id) => id !== node.id);
        await Promise.all(ids.map((id) => api.patch(`/nodes/${id}`, { parent: node.id })));
        toast(`已移动 ${ids.length} 项到「${node.name}」`, 'ok');
        clearSelection();
        refresh();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    if (Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      const files = await collectDroppedFiles(e.dataTransfer);
      if (files.length) uploader.addFiles(files, node.id);
    }
  });
}

/* ================================================================ 主题 / 侧栏 / 退出 */

function applyTheme() {
  const saved = localStorage.getItem('hfd-theme');
  const theme = saved || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
}

function updateThemeIcon() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  const use = $('#theme-icon use');
  if (use) use.setAttribute('href', isDark ? '#i-sun' : '#i-moon');
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('hfd-theme', next);
  updateThemeIcon();
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebar-backdrop').classList.add('open');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('open');
}

async function doLogout() {
  const ok = await confirmDialog({ title: '退出登录', message: '确定退出当前账号吗？', okText: '退出' });
  if (!ok) return;
  try { await api.post('/logout', {}); } catch {}
  location.reload();
}

/* ================================================================ 公开分享页 */

async function renderPublicShare(token) {
  $('#boot').classList.add('hidden');
  $('#app').classList.add('hidden');
  const root = $('#share-root');
  root.classList.remove('hidden');

  const page = h('div', { class: 'share-page' });
  root.replaceChildren(page);

  const load = async () => {
    page.replaceChildren(h('div', { class: 'share-page-card' },
      h('div', { class: 'share-page-head' }, h('div', { class: 'spinner' }), h('p', { text: '正在加载分享内容…' }))
    ));
    let info;
    try {
      info = await api.publicShare(token);
    } catch (err) {
      page.replaceChildren(h('div', { class: 'share-page-card' },
        h('div', { class: 'share-page-head' },
          h('div', { class: 'fi', style: 'margin:0 auto 14px;width:62px;height:62px;border-radius:18px;background:var(--danger-soft);color:var(--danger)' }, icon('info', 'lg')),
          h('h2', { text: '无法访问' }),
          h('p', { text: err.message })
        )
      ), h('div', { class: 'share-brand' }, icon('cloud', 'sm'), 'HF Drive'));
      return;
    }

    if (info.requiresPassword && !info.unlocked) {
      const pwd = h('input', { class: 'input', type: 'password', placeholder: '请输入提取密码', autocomplete: 'off' });
      const btn = h('button', { class: 'btn btn-primary', style: 'width:100%', text: '访问文件' });
      const errBox = h('div', { class: 'auth-err hidden' });
      const submit = async () => {
        if (!pwd.value) return;
        btn.disabled = true;
        btn.textContent = '验证中…';
        try {
          await api.unlockShare(token, pwd.value);
          load();
        } catch (err) {
          errBox.replaceChildren(icon('info', 'sm'), h('span', { text: err.message }));
          errBox.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = '访问文件';
        }
      };
      pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      btn.addEventListener('click', submit);
      page.replaceChildren(h('div', { class: 'share-page-card' },
        h('div', { class: 'share-page-head' },
          h('div', { class: 'fi folder', style: 'margin:0 auto 14px;width:62px;height:62px;border-radius:18px' }, icon('lock', 'lg')),
          h('h2', { text: info.name }),
          h('p', { text: '该分享已加密，请输入提取密码' })
        ),
        h('div', { class: 'share-page-body' }, errBox, pwd, h('div', { style: 'height:12px' }), btn)
      ), h('div', { class: 'share-brand' }, icon('cloud', 'sm'), 'HF Drive'));
      setTimeout(() => pwd.focus(), 100);
      return;
    }

    const kind = info.isFolder ? 'folder' : fileKind(info.name, info.mime);
    const actions = h('div', { class: 'share-actions-row' });
    if (info.allowDownload) {
      actions.append(h('a', { class: 'btn btn-primary', href: `/api/public/share/${token}/download` },
        icon('download', 'sm'), info.isFolder ? '打包下载' : '下载文件'));
    } else {
      actions.append(h('span', { class: 'badge', text: '分享者已关闭下载' }));
    }
    if (!info.isFolder) {
      actions.append(h('a', { class: 'btn', href: `/api/public/share/${token}/file/${info.id || ''}?inline=1`, target: '_blank', rel: 'noopener noreferrer' }, icon('eye', 'sm'), '在线预览'));
    }

    const body = h('div', { class: 'share-page-body' }, actions);

    if (info.isFolder && info.items) {
      const list = h('div', { class: 'share-files' });
      if (!info.items.length) {
        list.append(h('div', { class: 'share-file', style: 'justify-content:center;color:var(--muted)', text: '这个文件夹是空的' }));
      }
      for (const item of info.items) {
        const k = item.type === 'folder' ? 'folder' : fileKind(item.name, item.mime);
        list.append(h('div', { class: 'share-file' },
          fileIcon(k),
          h('span', { class: 'nm', text: item.name }),
          h('span', { class: 'sz', text: item.type === 'folder' ? '文件夹' : fmtBytes(item.size) }),
          item.type === 'file'
            ? h('a', { class: 'icon-btn', href: `/api/public/share/${token}/file/${item.id}`, title: '下载' }, icon('download', 'sm'))
            : null
        ));
      }
      body.append(list);
    }

    page.replaceChildren(h('div', { class: 'share-page-card' },
      h('div', { class: 'share-page-head' },
        fileIcon(kind, 'big'),
        h('h2', { text: info.name }),
        h('p', { text: `${info.isFolder ? '文件夹' : fmtBytes(info.size)} · ${info.expiresAt ? fmtTime(info.expiresAt) + ' 过期' : '永久有效'}` })
      ),
      body
    ), h('div', { class: 'share-brand' }, icon('cloud', 'sm'), '由 HF Drive 提供分享'));
  };

  load();
}
