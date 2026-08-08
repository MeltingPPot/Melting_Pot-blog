(function () {
  'use strict';

  var dictionaries = window.siteI18n || {};
  var supported = Object.keys(dictionaries);
  var fallback = supported[0] || 'zh-CN';
  var select = document.getElementById('site-language-select');

  function currentLanguage() {
    var saved = null;
    try { saved = window.localStorage.getItem('site-language'); } catch (error) {}
    return supported.indexOf(saved) >= 0 ? saved : (document.documentElement.lang || fallback);
  }

  function applyLanguage(language) {
    var dictionary = dictionaries[language] || dictionaries[fallback] || {};
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (Object.prototype.hasOwnProperty.call(dictionary, key)) node.textContent = dictionary[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-placeholder');
      if (Object.prototype.hasOwnProperty.call(dictionary, key)) node.setAttribute('placeholder', dictionary[key]);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-aria-label');
      if (Object.prototype.hasOwnProperty.call(dictionary, key)) node.setAttribute('aria-label', dictionary[key]);
    });
    if (select) select.value = language;
    try { window.localStorage.setItem('site-language', language); } catch (error) {}
    document.dispatchEvent(new CustomEvent('site:language-changed', { detail: { language: language } }));
  }

  if (!supported.length) return;
  applyLanguage(currentLanguage());
  if (select) select.addEventListener('change', function () { applyLanguage(select.value); });
}());
