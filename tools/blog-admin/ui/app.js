(function () {
  'use strict';

  var state = {
    token: '',
    posts: [],
    config: {},
    git: null,
    currentPost: null,
    filter: 'all',
    query: '',
    selectedDrafts: [],
    dirty: false,
    cnblogsXml: '',
    cnblogsArticles: [],
    encryptionUnlocked: true,
    encryptionPassword: '',
    previewTimer: null,
    toastTimer: null
  };

  var viewMeta = {
    posts: ['CONTENT', '文章管理'],
    editor: ['EDITOR', '文章编辑器'],
    settings: ['CONFIG', '站点设置'],
    import: ['MIGRATE', '批量导入'],
    publish: ['DEPLOY', '发布博客']
  };

  function element(selector, root) {
    return (root || document).querySelector(selector);
  }

  function elements(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char];
    });
  }

  function bytesToBase64(bytes) {
    var binary = '';
    var chunkSize = 32768;
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
    }
    return window.btoa(binary);
  }

  function base64ToBytes(value) {
    var binary = window.atob(String(value || ''));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function deriveEncryptionKey(password, salt, iterations) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('当前浏览器不支持安全加密，请升级浏览器。');
    var material = await window.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function renderMarkdownForEncryption(markdown) {
    if (!window.marked || !window.DOMPurify) throw new Error('Markdown 安全渲染组件尚未加载，请稍后重试。');
    window.marked.setOptions({ gfm: true, breaks: false });
    return window.DOMPurify.sanitize(window.marked.parse(markdown));
  }

  async function encryptPostDocument(markdown, password) {
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    var iterations = 600000;
    var key = await deriveEncryptionKey(password, salt, iterations);
    var documentData = JSON.stringify({
      version: 1,
      format: 'template-markdown',
      markdown: markdown,
      html: renderMarkdownForEncryption(markdown)
    });
    var ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      new TextEncoder().encode(documentData)
    );
    return {
      version: 1,
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: iterations,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  }

  async function decryptPostDocument(payload, password) {
    if (!payload || payload.version !== 1 || payload.algorithm !== 'AES-GCM' || payload.kdf !== 'PBKDF2' || payload.hash !== 'SHA-256') {
      throw new Error('文章没有可读取的有效密文。');
    }
    try {
      var salt = base64ToBytes(payload.salt);
      var iv = base64ToBytes(payload.iv);
      var ciphertext = base64ToBytes(payload.ciphertext);
      var key = await deriveEncryptionKey(password, salt, Number(payload.iterations));
      var plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ciphertext);
      var documentData = JSON.parse(new TextDecoder().decode(plaintext));
      if (documentData.version !== 1 || documentData.format !== 'template-markdown' || typeof documentData.markdown !== 'string' || typeof documentData.html !== 'string') {
        throw new Error('unsupported');
      }
      return documentData;
    } catch (error) {
      throw new Error('密码错误，或者文章密文已经损坏。');
    }
  }

  async function api(path, options) {
    var request = options || {};
    request.headers = Object.assign({}, request.headers || {}, {
      'Accept': 'application/json'
    });
    if (request.method && request.method !== 'GET') {
      request.headers['Content-Type'] = 'application/json';
      request.headers['X-Blog-Admin-Token'] = state.token;
    }
    var response = await fetch(path, request);
    var payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('本地服务返回了无法识别的内容。');
    }
    if (!response.ok) throw new Error(payload.error || '操作失败。');
    return payload;
  }

  function showToast(message, isError) {
    var toast = element('#toast');
    toast.textContent = message;
    toast.classList.toggle('is-error', Boolean(isError));
    toast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { toast.classList.remove('is-visible'); }, 3600);
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText || '处理中…';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    var indicator = element('#save-state');
    indicator.textContent = dirty ? '有未保存修改' : '已同步';
    indicator.classList.toggle('is-dirty', dirty);
  }

  function showView(name) {
    if (!viewMeta[name]) return;
    elements('.view').forEach(function (view) {
      view.classList.toggle('is-active', view.dataset.view === name);
    });
    elements('.nav-item[data-view-target]').forEach(function (item) {
      item.classList.toggle('is-active', item.dataset.viewTarget === name);
    });
    element('#view-eyebrow').textContent = viewMeta[name][0];
    element('#view-title').textContent = viewMeta[name][1];
    document.body.classList.remove('is-menu-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'publish') refreshGitStatus();
  }

  function formatDate(value) {
    if (!value) return '未设置日期';
    return String(value).replace('T', ' ').slice(0, 16);
  }

  function visiblePosts() {
    var query = state.query.trim().toLowerCase();
    return state.posts.filter(function (post) {
      if (state.filter !== 'all' && post.status !== state.filter) return false;
      if (!query) return true;
      var haystack = [post.title, post.subtitle, post.excerpt].concat(post.tags || []).join(' ').toLowerCase();
      return haystack.indexOf(query) >= 0;
    });
  }

  function updateBulkPublishBar() {
    var drafts = state.posts.filter(function (post) { return post.status === 'draft'; });
    var draftFiles = drafts.map(function (post) { return post.file; });
    state.selectedDrafts = state.selectedDrafts.filter(function (file) { return draftFiles.indexOf(file) >= 0; });
    var bar = element('#bulk-publish-bar');
    bar.hidden = drafts.length === 0;
    element('#bulk-publish-count').textContent = '已选择 ' + state.selectedDrafts.length + ' 篇';
    element('#bulk-publish-drafts').disabled = state.selectedDrafts.length === 0;
    var selectAll = element('#select-all-drafts');
    selectAll.checked = drafts.length > 0 && state.selectedDrafts.length === drafts.length;
    selectAll.indeterminate = state.selectedDrafts.length > 0 && state.selectedDrafts.length < drafts.length;
  }

  function renderPostList() {
    var list = element('#post-list');
    var posts = visiblePosts();
    list.innerHTML = '';
    element('#count-all').textContent = String(state.posts.length);
    element('#count-published').textContent = String(state.posts.filter(function (post) { return post.status === 'published'; }).length);
    element('#count-drafts').textContent = String(state.posts.filter(function (post) { return post.status === 'draft'; }).length);
    updateBulkPublishBar();

    if (!posts.length) {
      list.innerHTML = '<div class="empty-state"><strong>没有匹配的文章</strong><span>可以调整筛选条件，或者新建一篇文章。</span></div>';
      return;
    }

    posts.forEach(function (post) {
      var row = document.createElement('article');
      row.className = 'post-row';
      row.tabIndex = 0;
      row.dataset.file = post.file;
      var content = document.createElement('div');
      var title = document.createElement('h3');
      title.textContent = post.title;
      var excerpt = document.createElement('p');
      excerpt.textContent = post.subtitle || post.excerpt || '暂无摘要';
      var meta = document.createElement('div');
      meta.className = 'post-meta';
      (post.tags || []).slice(0, 5).forEach(function (tag) {
        var chip = document.createElement('span');
        chip.className = 'post-tag';
        chip.textContent = tag;
        meta.appendChild(chip);
      });
      if (post.mathjax) {
        var math = document.createElement('span');
        math.className = 'post-tag';
        math.textContent = 'MathJax';
        meta.appendChild(math);
      }
      if (post.encrypted) {
        var lock = document.createElement('span');
        lock.className = 'post-tag';
        lock.textContent = '🔒 加密';
        meta.appendChild(lock);
      }
      content.append(title, excerpt, meta);
      var badge = document.createElement('span');
      badge.className = 'status-badge' + (post.status === 'draft' ? ' is-draft' : '');
      badge.textContent = post.status === 'draft' ? '草稿' : '已发布';
      var date = document.createElement('time');
      date.className = 'post-date';
      date.textContent = formatDate(post.date).slice(0, 10);
      if (post.status === 'draft') {
        row.classList.add('has-draft-select');
        var select = document.createElement('input');
        select.type = 'checkbox';
        select.className = 'draft-select';
        select.checked = state.selectedDrafts.indexOf(post.file) >= 0;
        select.setAttribute('aria-label', '选择草稿：' + post.title);
        select.addEventListener('click', function (event) { event.stopPropagation(); });
        select.addEventListener('change', function (event) {
          if (event.target.checked && state.selectedDrafts.indexOf(post.file) < 0) state.selectedDrafts.push(post.file);
          if (!event.target.checked) state.selectedDrafts = state.selectedDrafts.filter(function (file) { return file !== post.file; });
          updateBulkPublishBar();
        });
        row.append(select, content, badge, date);
      } else {
        row.append(content, badge, date);
      }
      row.addEventListener('click', function () { openPost(post.file); });
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPost(post.file);
        }
      });
      list.appendChild(row);
    });
  }

  async function refreshPosts() {
    var payload = await api('/api/posts');
    state.posts = payload.posts;
    renderPostList();
  }

  async function bulkPublishDrafts() {
    var count = state.selectedDrafts.length;
    if (!count) return;
    if (!window.confirm('确定将选中的 ' + count + ' 篇草稿转为已发布吗？\n\n这一步只修改本地文件，之后仍需要到“发布”页面提交并推送。')) return;
    var button = element('#bulk-publish-drafts');
    setBusy(button, true, '正在处理…');
    try {
      var result = await api('/api/posts/bulk-publish', { method: 'POST', body: JSON.stringify({ files: state.selectedDrafts }) });
      state.selectedDrafts = [];
      await refreshPosts();
      showToast(result.message);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  function localDateTime() {
    var now = new Date();
    var offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 16);
  }

  function slugFromTitle(title) {
    return String(title || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100);
  }

  function updateEncryptionUi() {
    var fields = element('#post-form').elements;
    var enabled = fields.encrypted.checked;
    var locked = enabled && !state.encryptionUnlocked;
    var panel = element('#encryption-panel');
    panel.hidden = !enabled;
    panel.classList.toggle('is-locked', locked);
    panel.classList.toggle('is-unlocked', enabled && !locked);
    element('#unlock-post').hidden = !locked;
    element('#encryption-confirm-field').hidden = locked;
    fields.content.disabled = locked;

    if (!enabled) {
      element('#encryption-state').textContent = '未启用加密';
      element('#encryption-help').textContent = '保存后正文会以普通 Markdown 写入仓库。';
    } else if (locked) {
      element('#encryption-state').textContent = '正文已锁定';
      element('#encryption-help').textContent = '输入原密码并点击解锁；密码只在当前浏览器内使用。';
      fields.encryptionPassword.placeholder = '输入原文章密码';
    } else if (state.currentPost && state.currentPost.encrypted) {
      element('#encryption-state').textContent = '正文已在本次会话中解锁';
      element('#encryption-help').textContent = '密码框留空会沿用本次解锁密码；输入新密码可更换密码。';
      fields.encryptionPassword.placeholder = '留空则沿用原密码';
    } else {
      element('#encryption-state').textContent = '保存时加密正文';
      element('#encryption-help').textContent = '请输入至少 10 个字符的密码；密码不会保存，也无法找回。';
      fields.encryptionPassword.placeholder = '至少 10 个字符';
    }
  }

  function setPostForm(post, unlockedDocument) {
    var form = element('#post-form');
    var fields = form.elements;
    var hasUnlockedDocument = Boolean(post.encrypted && unlockedDocument);
    state.encryptionUnlocked = !post.encrypted || hasUnlockedDocument;
    state.encryptionPassword = hasUnlockedDocument ? unlockedDocument.password : '';
    fields.status.value = post.status || 'draft';
    fields.date.value = post.date || localDateTime();
    fields.title.value = post.title || '';
    fields.subtitle.value = post.subtitle || '';
    fields.slug.value = post.slug || '';
    fields.author.value = post.author || state.config.author || 'Example Author';
    fields.tags.value = (post.tags || []).join(', ');
    fields.headerImage.value = post.headerImage || 'img/bg-little-universe.jpg';
    fields.headerMask.value = String(post.headerMask == null ? 0.45 : post.headerMask);
    fields.mathjax.checked = Boolean(post.mathjax);
    fields.encrypted.checked = Boolean(post.encrypted);
    fields.encryptionPassword.value = '';
    fields.encryptionPasswordConfirm.value = '';
    fields.content.value = hasUnlockedDocument ? unlockedDocument.markdown : (post.encrypted ? '' : (post.content || ''));
    element('#mask-output').textContent = fields.headerMask.value;
    element('#trash-post').hidden = !post.file;
    updateEncryptionUi();
    renderPreview();
    setDirty(false);
  }

  async function unlockCurrentPost() {
    if (!state.currentPost || !state.currentPost.encrypted || state.encryptionUnlocked) return;
    var fields = element('#post-form').elements;
    var password = fields.encryptionPassword.value;
    if (!password) {
      showToast('请输入文章密码。', true);
      fields.encryptionPassword.focus();
      return;
    }
    var button = element('#unlock-post');
    setBusy(button, true, '正在解锁…');
    try {
      var documentData = await decryptPostDocument(state.currentPost.encryptedPayload, password);
      state.encryptionUnlocked = true;
      state.encryptionPassword = password;
      fields.content.value = documentData.markdown;
      fields.encryptionPassword.value = '';
      fields.encryptionPasswordConfirm.value = '';
      updateEncryptionUi();
      renderPreview();
      showToast('正文已解锁，密码只保留在本次管理面板会话中。');
    } catch (error) {
      showToast(error.message, true);
      fields.encryptionPassword.select();
    } finally {
      setBusy(button, false);
    }
  }

  function newPost() {
    state.currentPost = {
      file: '',
      status: 'draft',
      title: '',
      subtitle: '',
      date: localDateTime(),
      author: state.config.author || 'Example Author',
      headerImage: 'img/bg-little-universe.jpg',
      headerMask: 0.45,
      tags: [],
      mathjax: false,
      encrypted: false,
      encryptedPayload: null,
      slug: '',
      content: '## 从这里开始\n\n写下问题、背景和你的思考。\n',
      frontMatter: ''
    };
    setPostForm(state.currentPost);
    delete element('[name="slug"]', element('#post-form')).dataset.manuallyEdited;
    showView('editor');
    element('#view-title').textContent = '新建文章';
    element('[name="title"]', element('#post-form')).focus();
  }

  async function openPost(file) {
    try {
      var post = await api('/api/post?file=' + encodeURIComponent(file));
      state.currentPost = post;
      setPostForm(post);
      showView('editor');
      element('#view-title').textContent = post.title || '文章编辑器';
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function formPostPayload() {
    var fields = element('#post-form').elements;
    var encrypted = fields.encrypted.checked;
    var markdown = fields.content.value;
    var payload = {
      originalFile: state.currentPost ? state.currentPost.file : '',
      frontMatter: state.currentPost ? state.currentPost.frontMatter : '',
      status: fields.status.value,
      date: fields.date.value,
      title: fields.title.value,
      subtitle: fields.subtitle.value,
      slug: fields.slug.value,
      author: fields.author.value,
      tags: fields.tags.value.split(/[,，]/).map(function (tag) { return tag.trim(); }).filter(Boolean),
      headerImage: fields.headerImage.value,
      headerMask: Number(fields.headerMask.value),
      mathjax: fields.mathjax.checked,
      encrypted: encrypted,
      content: encrypted ? '' : markdown
    };
    var password = '';
    if (encrypted) {
      if (!state.encryptionUnlocked) throw new Error('请先输入原密码解锁正文。');
      var newPassword = fields.encryptionPassword.value;
      password = newPassword || state.encryptionPassword;
      if (!password) throw new Error('请为加密文章设置密码。');
      if (password.length < 10) throw new Error('文章密码至少需要 10 个字符。');
      if (newPassword && newPassword !== fields.encryptionPasswordConfirm.value) throw new Error('两次输入的文章密码不一致。');
      payload.encryptedPayload = await encryptPostDocument(markdown, password);
    }
    return { payload: payload, markdown: markdown, password: password };
  }

  async function savePost(event) {
    event.preventDefault();
    var button = event.submitter || element('#post-form .primary-button');
    setBusy(button, true, '保存中…');
    try {
      var prepared = await formPostPayload();
      var payload = await api('/api/posts/save', { method: 'POST', body: JSON.stringify(prepared.payload) });
      state.currentPost = payload.post;
      setPostForm(payload.post, payload.post.encrypted ? { markdown: prepared.markdown, password: prepared.password } : null);
      await refreshPosts();
      element('#view-title').textContent = payload.post.title;
      showToast(payload.message);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  async function trashCurrentPost() {
    if (!state.currentPost || !state.currentPost.file) return;
    if (!window.confirm('文章会被移入 .blog-admin-trash，本地仍可恢复。确定继续吗？')) return;
    var button = element('#trash-post');
    setBusy(button, true, '移动中…');
    try {
      var payload = await api('/api/posts/trash', {
        method: 'POST',
        body: JSON.stringify({ file: state.currentPost.file })
      });
      state.currentPost = null;
      await refreshPosts();
      showView('posts');
      showToast(payload.message);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  function renderPreview() {
    var preview = element('#markdown-preview');
    var fields = element('#post-form').elements;
    if (fields.encrypted.checked && !state.encryptionUnlocked) {
      preview.innerHTML = '<div class="encrypted-preview-lock"><span aria-hidden="true">🔒</span><strong>正文尚未解锁</strong><span>输入文章密码后才能预览或编辑。</span></div>';
      return;
    }
    var markdown = fields.content.value || '';
    var rendered;
    if (window.marked && window.DOMPurify) {
      window.marked.setOptions({ gfm: true, breaks: false });
      rendered = window.marked.parse(markdown);
      rendered = window.DOMPurify.sanitize(rendered);
    } else {
      rendered = '<pre>' + escapeHtml(markdown) + '</pre>';
    }
    preview.innerHTML = '<h1 class="preview-title">' + escapeHtml(fields.title.value || '未命名文章') + '</h1>' +
      '<p class="preview-subtitle">' + escapeHtml(fields.subtitle.value || '') + '</p><hr class="preview-rule">' + rendered;
    if (fields.mathjax.checked && preview.classList.contains('is-active') && window.MathJax && window.MathJax.typesetPromise) {
      if (window.MathJax.typesetClear) window.MathJax.typesetClear([preview]);
      window.MathJax.typesetPromise([preview]).catch(function () {});
    }
  }

  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(renderPreview, 180);
  }

  function fillSettings() {
    var form = element('#settings-form');
    Object.keys(state.config).forEach(function (key) {
      var field = form.elements[key];
      if (!field) return;
      field.value = Array.isArray(state.config[key]) ? state.config[key].join('\n') : state.config[key];
    });
  }

  async function saveSettings(event) {
    event.preventDefault();
    var button = event.submitter;
    var form = event.currentTarget;
    var payload = {};
    ['title', 'SEOTitle', 'description', 'keyword', 'home-tagline', 'home-status', 'footer-signature', 'github_username', 'sidebar-about-description'].forEach(function (key) {
      payload[key] = form.elements[key].value;
    });
    payload['home-principles'] = form.elements['home-principles'].value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    setBusy(button, true, '保存中…');
    try {
      var result = await api('/api/config/save', { method: 'POST', body: JSON.stringify(payload) });
      state.config = result.config;
      fillSettings();
      setDirty(false);
      showToast(result.message);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  function renderGitStatus() {
    if (!state.git) return;
    element('#git-branch').textContent = state.git.branch || 'main';
    var container = element('#git-state');
    container.innerHTML = '';
    if (state.git.clean) {
      container.innerHTML = '<div class="git-clean"><strong>工作区干净</strong><span>暂无需要提交的修改。</span></div>';
      return;
    }
    state.git.changes.forEach(function (line) {
      var row = document.createElement('div');
      row.className = 'git-change';
      var code = document.createElement('code');
      code.textContent = line.slice(0, 2).trim() || 'M';
      var path = document.createElement('span');
      path.textContent = line.slice(3);
      row.append(code, path);
      container.appendChild(row);
    });
  }

  async function refreshGitStatus() {
    try {
      state.git = await api('/api/git/status');
      renderGitStatus();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function publish(event) {
    event.preventDefault();
    var button = event.submitter;
    var message = event.currentTarget.elements.message.value;
    setBusy(button, true, '正在推送…');
    try {
      var result = await api('/api/publish', { method: 'POST', body: JSON.stringify({ message: message }) });
      state.git = result.status;
      renderGitStatus();
      showToast(result.message);
    } catch (error) {
      showToast(error.message, true);
      await refreshGitStatus();
    } finally {
      setBusy(button, false);
    }
  }

  function renderCnblogsPreview() {
    var list = element('#cnblogs-preview-list');
    var articles = state.cnblogsArticles;
    list.innerHTML = '';
    element('#cnblogs-import-summary').textContent = articles.length ? '共 ' + articles.length + ' 篇，可选择导入' : '尚未读取 XML';
    element('#cnblogs-select-all').disabled = !articles.length;
    element('#cnblogs-import').disabled = !articles.length;
    if (!articles.length) {
      list.innerHTML = '<div class="empty-state"><strong>没有可预览的文章</strong><span>请选择有效的博客园 XML 备份。</span></div>';
      return;
    }
    articles.forEach(function (article) {
      var row = document.createElement('label');
      row.className = 'import-row';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.importId = String(article.id);
      checkbox.addEventListener('change', function () {
        var checked = elements('#cnblogs-preview-list input[type="checkbox"]:checked').length;
        element('#cnblogs-import').disabled = checked === 0;
        element('#cnblogs-select-all').checked = checked === articles.length;
      });
      var body = document.createElement('span');
      body.className = 'import-row-body';
      var title = document.createElement('strong');
      title.textContent = article.title;
      var meta = document.createElement('small');
      meta.textContent = formatDate(article.date) + ' · ' + (article.tags || []).join(', ') + (article.mathjax ? ' · MathJax' : '');
      var excerpt = document.createElement('em');
      excerpt.textContent = article.excerpt || '（正文为空）';
      body.append(title, meta, excerpt);
      row.append(checkbox, body);
      list.appendChild(row);
    });
  }

  async function previewCnblogs() {
    var button = element('#cnblogs-preview');
    if (!state.cnblogsXml) return;
    setBusy(button, true, '正在读取…');
    try {
      var result = await api('/api/import/cnblogs/preview', { method: 'POST', body: JSON.stringify({ xml: state.cnblogsXml }) });
      state.cnblogsArticles = result.articles;
      renderCnblogsPreview();
      showToast('已读取 ' + result.articles.length + ' 篇文章。');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  async function importCnblogs() {
    var ids = elements('#cnblogs-preview-list input[data-import-id]:checked').map(function (input) { return Number(input.dataset.importId); });
    if (!ids.length || !state.cnblogsXml) {
      showToast('请至少选择一篇文章。', true);
      return;
    }
    var button = element('#cnblogs-import');
    setBusy(button, true, '正在导入…');
    try {
      var result = await api('/api/import/cnblogs', { method: 'POST', body: JSON.stringify({ xml: state.cnblogsXml, ids: ids }) });
      await refreshPosts();
      showToast(result.message);
      showView('posts');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  function setWritingTab(name) {
    elements('[data-writing-tab]').forEach(function (tab) { tab.classList.toggle('is-active', tab.dataset.writingTab === name); });
    elements('[data-writing-surface]').forEach(function (surface) { surface.classList.toggle('is-active', surface.dataset.writingSurface === name); });
    if (name === 'preview') renderPreview();
  }

  function setupEvents() {
    document.addEventListener('click', function (event) {
      var viewButton = event.target.closest('[data-view-target]');
      if (viewButton) {
        if (state.dirty && !window.confirm('存在未保存修改，确定离开当前页面吗？')) return;
        setDirty(false);
        showView(viewButton.dataset.viewTarget);
      }
      if (event.target.closest('[data-action="new-post"]')) {
        if (state.dirty && !window.confirm('存在未保存修改，确定新建文章吗？')) return;
        newPost();
      }
      var writingTab = event.target.closest('[data-writing-tab]');
      if (writingTab) setWritingTab(writingTab.dataset.writingTab);
    });

    element('#post-search').addEventListener('input', function (event) {
      state.query = event.target.value;
      renderPostList();
    });
    elements('[data-post-filter]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.filter = button.dataset.postFilter;
        elements('[data-post-filter]').forEach(function (item) { item.classList.toggle('is-active', item === button); });
        renderPostList();
      });
    });
    element('#select-all-drafts').addEventListener('change', function (event) {
      state.selectedDrafts = event.target.checked
        ? state.posts.filter(function (post) { return post.status === 'draft'; }).map(function (post) { return post.file; })
        : [];
      renderPostList();
    });
    element('#bulk-publish-drafts').addEventListener('click', bulkPublishDrafts);

    element('#post-form').addEventListener('submit', savePost);
    element('#post-form').addEventListener('input', function (event) {
      if ((event.target.name === 'encryptionPassword' || event.target.name === 'encryptionPasswordConfirm') && !state.encryptionUnlocked) return;
      setDirty(true);
      if (event.target.name === 'headerMask') element('#mask-output').textContent = event.target.value;
      if (event.target.name === 'title' && state.currentPost && !state.currentPost.file && !element('[name="slug"]', event.currentTarget).dataset.manuallyEdited) {
        element('[name="slug"]', event.currentTarget).value = slugFromTitle(event.target.value);
      }
      schedulePreview();
    });
    element('[name="encrypted"]', element('#post-form')).addEventListener('change', function (event) {
      if (state.currentPost && state.currentPost.encrypted && !state.encryptionUnlocked && !event.target.checked) {
        event.target.checked = true;
        showToast('请先使用原密码解锁正文，再关闭加密。', true);
      }
      updateEncryptionUi();
      renderPreview();
    });
    element('#unlock-post').addEventListener('click', unlockCurrentPost);
    element('[name="slug"]', element('#post-form')).addEventListener('input', function (event) { event.target.dataset.manuallyEdited = 'true'; });
    element('#trash-post').addEventListener('click', trashCurrentPost);
    element('#settings-form').addEventListener('submit', saveSettings);
    element('#settings-form').addEventListener('input', function () { setDirty(true); });
    element('#publish-form').addEventListener('submit', publish);
    element('#cnblogs-file').addEventListener('change', async function (event) {
      var file = event.target.files[0];
      state.cnblogsXml = '';
      state.cnblogsArticles = [];
      element('#cnblogs-file-name').textContent = file ? file.name + ' · ' + Math.ceil(file.size / 1024) + ' KB' : '尚未选择文件';
      element('#cnblogs-preview').disabled = !file;
      element('#cnblogs-import').disabled = true;
      renderCnblogsPreview();
      if (!file) return;
      try {
        state.cnblogsXml = await file.text();
      } catch (error) {
        showToast('无法读取所选 XML 文件。', true);
      }
    });
    element('#cnblogs-preview').addEventListener('click', previewCnblogs);
    element('#cnblogs-import').addEventListener('click', importCnblogs);
    element('#cnblogs-select-all').addEventListener('change', function (event) {
      elements('#cnblogs-preview-list input[data-import-id]').forEach(function (input) { input.checked = event.target.checked; });
      element('#cnblogs-import').disabled = !event.target.checked;
    });
    element('#refresh-button').addEventListener('click', async function () {
      try {
        await Promise.all([refreshPosts(), refreshGitStatus()]);
        showToast('数据已刷新。');
      } catch (error) {
        showToast(error.message, true);
      }
    });
    element('.mobile-menu').addEventListener('click', function () { document.body.classList.toggle('is-menu-open'); });
    element('#admin-theme-toggle').addEventListener('click', function () {
      var theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      localStorage.setItem('example-site-admin-theme', theme);
      updateThemeLabel();
    });
    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function updateThemeLabel() {
    element('#admin-theme-toggle').textContent = document.documentElement.dataset.theme === 'dark' ? '切换日间模式' : '切换夜间模式';
  }

  async function initialize() {
    setupEvents();
    updateThemeLabel();
    try {
      var session = await api('/api/session');
      state.token = session.token;
      var results = await Promise.all([api('/api/posts'), api('/api/config'), api('/api/git/status')]);
      state.posts = results[0].posts;
      state.config = results[1];
      state.git = results[2];
      renderPostList();
      fillSettings();
      renderGitStatus();
      element('#loading-screen').classList.add('is-hidden');
    } catch (error) {
      element('#loading-screen p').textContent = error.message;
      showToast(error.message, true);
    }
  }

  initialize();
}());
