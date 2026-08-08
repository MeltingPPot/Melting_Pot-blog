(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function setupThemeToggle() {
    var storageKey = 'example-site-theme';
    var toggle = document.querySelector('.theme-toggle');
    var icon = toggle && toggle.querySelector('.theme-toggle__icon');
    var label = toggle && toggle.querySelector('.theme-toggle__label');
    var colorScheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (!toggle) return;

    function getSavedTheme() {
      try {
        return window.localStorage.getItem(storageKey);
      } catch (error) {
        return null;
      }
    }

    function translated(key, fallback) {
      var language = document.documentElement.lang || 'zh-CN';
      var dictionary = (window.siteI18n && window.siteI18n[language]) || {};
      return dictionary[key] || fallback;
    }

    function applyTheme(theme) {
      var dark = theme === 'dark';
      var nextName = dark ? translated('nav_theme_light', '日间') : translated('nav_theme_dark', '夜间');
      var nextLabel = dark ? translated('nav_theme_to_light', '切换到日间模式') : translated('nav_theme_to_dark', '切换到夜间模式');
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.colorScheme = theme;
      icon.textContent = dark ? '☀' : '☾';
      label.textContent = nextName;
      toggle.setAttribute('aria-label', nextLabel);
      toggle.setAttribute('title', nextLabel);
      toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');

      var themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) themeMeta.setAttribute('content', dark ? '#202126' : '#f5f5f3');
    }

    function saveTheme(theme) {
      try {
        window.localStorage.setItem(storageKey, theme);
      } catch (error) {
        // Theme still works for this page when storage is unavailable.
      }
    }

    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    document.addEventListener('site:language-changed', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    });
    toggle.addEventListener('click', function () {
      var nextTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
      saveTheme(nextTheme);
    });

    if (colorScheme && colorScheme.addEventListener) {
      colorScheme.addEventListener('change', function (event) {
        if (!getSavedTheme()) applyTheme(event.matches ? 'dark' : 'light');
      });
    }
  }

  function setupTerminalDecode() {
    var title = document.querySelector('.js-terminal-decode');
    if (!title || reduceMotion) return;

    var finalText = title.textContent.trim();
    var glyphs = '01<>/{}[]*+#@$';
    var startedAt = 0;
    var duration = 920;

    function render(timestamp) {
      if (!startedAt) startedAt = timestamp;
      var progress = clamp((timestamp - startedAt) / duration, 0, 1);
      var resolved = Math.floor(progress * finalText.length);
      var output = '';

      for (var i = 0; i < finalText.length; i += 1) {
        if (finalText[i] === ' ') {
          output += ' ';
        } else if (i < resolved || progress === 1) {
          output += finalText[i];
        } else {
          output += glyphs[Math.floor(Math.random() * glyphs.length)];
        }
      }

      title.textContent = output;
      if (progress < 1) window.requestAnimationFrame(render);
    }

    window.setTimeout(function () {
      window.requestAnimationFrame(render);
    }, 180);
  }

  function setupHeroParticles() {
    var hero = document.querySelector('.home-hero');
    var canvas = hero && hero.querySelector('.hero-particles');
    if (!hero || !canvas || reduceMotion) return;

    var context = canvas.getContext('2d');
    if (!context) return;

    var width = 0;
    var height = 0;
    var particles = [];
    var frameId = null;
    var pointer = { x: -1000, y: -1000, active: false };

    function createParticle() {
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: 0.08 + Math.random() * 0.2,
        radius: 0.7 + Math.random() * 1.35,
        alpha: 0.2 + Math.random() * 0.55
      };
    }

    function resize() {
      var rect = hero.getBoundingClientRect();
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(rect.width, 1);
      height = Math.max(rect.height, 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      var targetCount = clamp(Math.round(width / 23), 24, 64);
      particles = Array.from({ length: targetCount }, createParticle);
    }

    function drawConnections() {
      for (var i = 0; i < particles.length; i += 1) {
        for (var j = i + 1; j < particles.length; j += 1) {
          var dx = particles[i].x - particles[j].x;
          var dy = particles[i].y - particles[j].y;
          var distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 105) {
            context.strokeStyle = 'rgba(235, 235, 235, ' + ((1 - distance / 105) * 0.1) + ')';
            context.lineWidth = 0.7;
            context.beginPath();
            context.moveTo(particles[i].x, particles[i].y);
            context.lineTo(particles[j].x, particles[j].y);
            context.stroke();
          }
        }
      }
    }

    function drawFrame() {
      context.clearRect(0, 0, width, height);
      drawConnections();

      particles.forEach(function (particle) {
        particle.x += particle.vx;
        particle.y -= particle.vy;

        if (particle.y < -10) {
          particle.y = height + 10;
          particle.x = Math.random() * width;
        }
        if (particle.x < -10) particle.x = width + 10;
        if (particle.x > width + 10) particle.x = -10;

        context.fillStyle = 'rgba(235, 235, 235, ' + particle.alpha + ')';
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();

        if (pointer.active) {
          var dx = particle.x - pointer.x;
          var dy = particle.y - pointer.y;
          var distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 145) {
            context.strokeStyle = 'rgba(235, 235, 235, ' + ((1 - distance / 145) * 0.24) + ')';
            context.lineWidth = 0.8;
            context.beginPath();
            context.moveTo(particle.x, particle.y);
            context.lineTo(pointer.x, pointer.y);
            context.stroke();
          }
        }
      });

      frameId = window.requestAnimationFrame(drawFrame);
    }

    if (finePointer) {
      hero.addEventListener('pointermove', function (event) {
        var rect = hero.getBoundingClientRect();
        pointer.x = event.clientX - rect.left;
        pointer.y = event.clientY - rect.top;
        pointer.active = true;
      });
      hero.addEventListener('pointerleave', function () {
        pointer.active = false;
      });
    }

    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      } else if (!document.hidden && !frameId) {
        drawFrame();
      }
    });

    resize();
    drawFrame();
  }

  function setupRevealEffects() {
    var home = document.querySelector('.home-hero');
    var targets = [];

    if (home) {
      targets = Array.prototype.slice.call(document.querySelectorAll(
        '.home-console, .postlist-container .post-preview, .sidebar-container > section'
      ));
    } else if (document.querySelector('.reading-progress')) {
      targets = Array.prototype.slice.call(document.querySelectorAll('.post-container h2, .post-container h3'));
      targets.forEach(function (target) {
        target.setAttribute('data-chapter-reveal', '');
      });
    }

    if (!targets.length) return;
    targets.forEach(function (target, index) {
      target.setAttribute('data-reveal', '');
      target.style.setProperty('--reveal-delay', Math.min(index % 5, 4) * 70 + 'ms');
    });

    if (reduceMotion || !('IntersectionObserver' in window)) {
      targets.forEach(function (target) { target.classList.add('is-visible'); });
      return;
    }

    document.body.classList.add('motion-ready');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -28px' });

    targets.forEach(function (target) { observer.observe(target); });
  }

  function revealUnlockedPost(event) {
    var container = event.detail && event.detail.container;
    if (!container) return;
    Array.prototype.forEach.call(container.querySelectorAll('h2, h3'), function (heading) {
      heading.setAttribute('data-chapter-reveal', '');
      heading.setAttribute('data-reveal', '');
      heading.classList.add('is-visible');
    });
  }

  function setupCardTilt() {
    if (reduceMotion || !finePointer || !document.querySelector('.home-hero')) return;

    var cards = document.querySelectorAll('.postlist-container .post-preview');
    cards.forEach(function (card) {
      var pendingFrame = null;
      card.classList.add('tilt-card');

      card.addEventListener('pointermove', function (event) {
        if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
        pendingFrame = window.requestAnimationFrame(function () {
          var rect = card.getBoundingClientRect();
          var x = (event.clientX - rect.left) / rect.width;
          var y = (event.clientY - rect.top) / rect.height;
          card.style.setProperty('--tilt-x', ((0.5 - y) * 4.5).toFixed(2) + 'deg');
          card.style.setProperty('--tilt-y', ((x - 0.5) * 5.5).toFixed(2) + 'deg');
          card.style.setProperty('--glow-x', (x * 100).toFixed(1) + '%');
          card.style.setProperty('--glow-y', (y * 100).toFixed(1) + '%');
        });
      });

      card.addEventListener('pointerleave', function () {
        card.style.setProperty('--tilt-x', '0deg');
        card.style.setProperty('--tilt-y', '0deg');
        card.style.setProperty('--glow-x', '50%');
        card.style.setProperty('--glow-y', '50%');
      });
    });
  }

  function setupReadingProgress() {
    var progress = document.querySelector('.reading-progress');
    var fill = progress && progress.querySelector('span');
    var article = document.querySelector('article');
    if (!progress || !fill || !article) return;

    var ticking = false;
    function update() {
      var articleTop = article.getBoundingClientRect().top + window.pageYOffset;
      var start = articleTop - window.innerHeight * 0.2;
      var end = articleTop + article.offsetHeight - window.innerHeight;
      var amount = end <= start ? 1 : clamp((window.pageYOffset - start) / (end - start), 0, 1);
      fill.style.transform = 'scaleX(' + amount.toFixed(4) + ')';
      progress.setAttribute('aria-valuenow', String(Math.round(amount * 100)));
      ticking = false;
    }

    function requestUpdate() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }

    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate, { passive: true });
    update();
  }

  setupThemeToggle();
  setupTerminalDecode();
  setupHeroParticles();
  setupRevealEffects();
  setupCardTilt();
  setupReadingProgress();
  document.addEventListener('template:post-unlocked', revealUnlockedPost);
}());
