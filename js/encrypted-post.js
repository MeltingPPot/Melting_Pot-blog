(function () {
  'use strict';

  function base64ToBytes(value) {
    var binary = window.atob(String(value || ''));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function deriveKey(password, payload) {
    var material = await window.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(payload.salt),
        iterations: Number(payload.iterations),
        hash: 'SHA-256'
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  async function decryptDocument(payload, password) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('当前浏览器不支持安全解密，请升级浏览器。');
    if (!payload || payload.version !== 1 || payload.algorithm !== 'AES-GCM' || payload.kdf !== 'PBKDF2' || payload.hash !== 'SHA-256') {
      throw new Error('文章密文格式不受支持。');
    }
    try {
      var key = await deriveKey(password, payload);
      var plaintext = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
        key,
        base64ToBytes(payload.ciphertext)
      );
      var documentData = JSON.parse(new TextDecoder().decode(plaintext));
      if (documentData.version !== 1 || documentData.format !== 'template-markdown' || typeof documentData.html !== 'string' || typeof documentData.markdown !== 'string') {
        throw new Error('unsupported');
      }
      return documentData;
    } catch (error) {
      throw new Error('密码错误，或者文章密文已经损坏。');
    }
  }

  function headingSlug(text, index) {
    var slug = String(text || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    try {
      slug = slug.replace(/[^\p{L}\p{N}-]+/gu, '');
    } catch (error) {
      slug = slug.replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '');
    }
    return slug || 'section-' + index;
  }

  function addHeadingIds(container) {
    var used = Object.create(null);
    Array.prototype.forEach.call(container.querySelectorAll('h1,h2,h3,h4,h5,h6'), function (heading, index) {
      if (heading.id) return;
      var base = headingSlug(heading.textContent, index + 1);
      var id = base;
      var serial = 2;
      while (used[id] || document.getElementById(id)) {
        id = base + '-' + serial;
        serial += 1;
      }
      used[id] = true;
      heading.id = id;
    });
  }

  function makeTablesResponsive(container) {
    Array.prototype.forEach.call(container.querySelectorAll('table'), function (table) {
      table.classList.add('table');
      if (table.parentElement && table.parentElement.classList.contains('table-responsive')) return;
      var wrapper = document.createElement('div');
      wrapper.className = 'table-responsive';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  function highlightCode(container) {
    var keywords = 'alignas alignof and asm auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while async await def elif except finally from global import in is lambda nonlocal not or pass raise with yield function let var interface extends implements package'.split(' ');
    var keywordPattern = keywords.join('|');
    var tokenPattern = new RegExp('(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|\\b(?:' + keywordPattern + ')\\b|\\b(?:0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b)', 'g');

    Array.prototype.forEach.call(container.querySelectorAll('pre code'), function (code) {
      var text = code.textContent;
      var fragment = document.createDocumentFragment();
      var lastIndex = 0;
      var match;
      while ((match = tokenPattern.exec(text))) {
        if (match.index > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        var token = document.createElement('span');
        if (/^(?:\/|#)/.test(match[0])) token.className = 'tok-comment';
        else if (/^["']/.test(match[0])) token.className = 'tok-string';
        else if (/^(?:0x|\d)/i.test(match[0])) token.className = 'tok-number';
        else token.className = 'tok-keyword';
        token.textContent = match[0];
        fragment.appendChild(token);
        lastIndex = tokenPattern.lastIndex;
      }
      if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      code.replaceChildren(fragment);
    });
  }

  function secureLinks(container) {
    Array.prototype.forEach.call(container.querySelectorAll('a[href]'), function (link) {
      try {
        var url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) link.rel = 'noopener noreferrer';
      } catch (error) {
        // Keep malformed links inert instead of interrupting article rendering.
      }
    });
  }

  function rebuildCatalog() {
    if (typeof window.generateCatalog === 'function') window.generateCatalog('.catalog-body');
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.onePageNav) {
      window.jQuery('.catalog-body').onePageNav({
        currentClass: 'active',
        changeHash: false,
        easing: 'swing',
        scrollSpeed: 700,
        scrollOffset: 0,
        scrollThreshold: 0.2,
        padding: 80
      });
    }
  }

  function typesetMath(container) {
    if (window.MathJax && window.MathJax.Hub) {
      window.MathJax.Hub.Queue(['Typeset', window.MathJax.Hub, container]);
      return;
    }
    var script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.5/MathJax.js?config=TeX-AMS-MML_SVG';
    script.integrity = 'sha384-3lJUsx1TJHt7BA4udB5KPnDrlkO8T6J6v/op7ui0BbCjvZ9WqV4Xm6DTP6kQ/iBH';
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.async = true;
    script.onload = function () {
      if (!window.MathJax || !window.MathJax.Hub) return;
      window.MathJax.Hub.Config({
        TeX: { extensions: ['AMSmath.js', 'AMSsymbols.js'], equationNumbers: { autoNumber: 'AMS' } },
        SVG: { scale: 90 },
        tex2jax: {
          inlineMath: [['$', '$'], ['\\(', '\\)']],
          displayMath: [['$$', '$$'], ['\\[', '\\]']],
          processEscapes: true,
          processEnvironments: true
        }
      });
      window.MathJax.Hub.Queue(['Typeset', window.MathJax.Hub, container]);
    };
    document.head.appendChild(script);
  }

  function revealDocument(documentData, gate, container) {
    container.innerHTML = documentData.html;
    addHeadingIds(container);
    makeTablesResponsive(container);
    highlightCode(container);
    secureLinks(container);
    container.hidden = false;
    gate.remove();
    rebuildCatalog();
    document.dispatchEvent(new CustomEvent('template:post-unlocked', { detail: { container: container } }));
    window.dispatchEvent(new Event('resize'));
    if (gate.dataset.mathjax === 'true') typesetMath(container);
  }

  function initialize() {
    var gate = document.getElementById('encrypted-post-gate');
    var form = document.getElementById('encrypted-post-form');
    var passwordInput = document.getElementById('encrypted-post-password');
    var errorOutput = document.getElementById('encrypted-post-error');
    var dataElement = document.getElementById('encrypted-post-data');
    var content = document.getElementById('protected-post-content');
    if (!gate || !form || !passwordInput || !errorOutput || !dataElement || !content) return;

    var payload;
    try {
      payload = JSON.parse(dataElement.textContent);
    } catch (error) {
      errorOutput.textContent = '文章密文无法读取。';
      form.querySelector('button').disabled = true;
      return;
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var button = form.querySelector('button');
      var password = passwordInput.value;
      if (!password) return;
      button.disabled = true;
      button.textContent = '正在解锁…';
      errorOutput.textContent = '';
      try {
        var documentData = await decryptDocument(payload, password);
        passwordInput.value = '';
        password = '';
        dataElement.remove();
        revealDocument(documentData, gate, content);
      } catch (error) {
        errorOutput.textContent = error.message;
        password = '';
        passwordInput.select();
        button.disabled = false;
        button.textContent = '解锁正文';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
}());
