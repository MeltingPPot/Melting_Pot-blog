(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BlogMathMarkdown = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var backtick = String.fromCharCode(96);

  function makePrefix(source, label) {
    var prefix = 'MP' + label + 'PLACEHOLDERTOKEN';
    while (source.indexOf(prefix) !== -1) prefix += 'X';
    return prefix;
  }

  function tokenFor(prefix, index) {
    return prefix + String(index) + 'END';
  }

  function restoreRaw(source, prefix, values) {
    var restored = source;
    values.forEach(function (value, index) {
      restored = restored.split(tokenFor(prefix, index)).join(value);
    });
    return restored;
  }

  function protectPattern(source, pattern, store) {
    return source.replace(pattern, function (match) {
      return store(match);
    });
  }

  function protectFencedCode(source, store) {
    var openingPattern = new RegExp('^ {0,3}((' + backtick + '{3,})|(~{3,}))');
    var output = '';
    var index = 0;

    while (index < source.length) {
      var firstNewline = source.indexOf('\n', index);
      var firstEnd = firstNewline === -1 ? source.length : firstNewline + 1;
      var firstLine = source.slice(index, firstEnd).replace(/\r?\n$/, '');
      var opening = openingPattern.exec(firstLine);

      if (!opening) {
        output += source.slice(index, firstEnd);
        index = firstEnd;
        continue;
      }

      var fence = opening[1];
      var fenceCharacter = fence.charAt(0);
      var closingPattern = new RegExp(
        '^ {0,3}' + fenceCharacter + '{' + String(fence.length) + ',}[ \\t]*$'
      );
      var scan = firstEnd;
      var blockEnd = -1;

      while (scan < source.length) {
        var newline = source.indexOf('\n', scan);
        var lineEnd = newline === -1 ? source.length : newline + 1;
        var line = source.slice(scan, lineEnd).replace(/\r?\n$/, '');
        if (closingPattern.test(line)) {
          blockEnd = lineEnd;
          break;
        }
        scan = lineEnd;
      }

      if (blockEnd === -1) {
        output += source.slice(index);
        break;
      }

      output += store(source.slice(index, blockEnd));
      index = blockEnd;
    }

    return output;
  }

  function protectCode(source) {
    var values = [];
    var prefix = makePrefix(source, 'CODE');

    function store(value) {
      var token = tokenFor(prefix, values.length);
      values.push(value);
      return token;
    }

    var protectedSource = protectFencedCode(source, store);
    protectedSource = protectPattern(
      protectedSource,
      /<(script|style|textarea|pre|code)\b[\s\S]*?<\/\1>/gi,
      store
    );
    protectedSource = protectPattern(protectedSource, /<!--[\s\S]*?-->/g, store);
    protectedSource = protectPattern(
      protectedSource,
      /(^|\n)((?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+)/g,
      function (match) {
        var leading = match.charAt(0) === '\n' ? '\n' : '';
        return leading + store(match.slice(leading.length));
      }
    );
    protectedSource = protectPattern(
      protectedSource,
      new RegExp('(' + backtick + '+)([\\s\\S]*?)\\1', 'g'),
      store
    );

    return {
      markdown: protectedSource,
      prefix: prefix,
      values: values
    };
  }

  function isEscaped(source, index) {
    var slashCount = 0;
    for (var cursor = index - 1; cursor >= 0 && source.charAt(cursor) === '\\'; cursor -= 1) {
      slashCount += 1;
    }
    return slashCount % 2 === 1;
  }

  function findDelimiter(source, delimiter, fromIndex, singleDollar) {
    var index = source.indexOf(delimiter, fromIndex);
    while (index !== -1) {
      var besideDollar = singleDollar &&
        (source.charAt(index - 1) === '$' || source.charAt(index + 1) === '$');
      if (!isEscaped(source, index) && !besideDollar) return index;
      index = source.indexOf(delimiter, index + delimiter.length);
    }
    return -1;
  }

  function protectDelimited(source, opening, closing, allowNewlines, singleDollar, store) {
    var output = '';
    var cursor = 0;
    var searchFrom = 0;

    while (searchFrom < source.length) {
      var start = findDelimiter(source, opening, searchFrom, singleDollar);
      if (start === -1) break;
      var end = findDelimiter(source, closing, start + opening.length, singleDollar);
      if (end === -1) break;

      var content = source.slice(start + opening.length, end);
      if (!allowNewlines && /[\r\n]/.test(content)) {
        searchFrom = start + opening.length;
        continue;
      }

      output += source.slice(cursor, start);
      output += store(source.slice(start, end + closing.length));
      cursor = end + closing.length;
      searchFrom = cursor;
    }

    return output + source.slice(cursor);
  }

  function protectMath(markdown) {
    var source = String(markdown || '');
    var code = protectCode(source);
    var expressions = [];
    var prefix = makePrefix(source, 'MATH');

    function store(value) {
      var token = tokenFor(prefix, expressions.length);
      expressions.push(value);
      return token;
    }

    var protectedSource = code.markdown;
    protectedSource = protectDelimited(protectedSource, '$$', '$$', true, false, store);
    protectedSource = protectDelimited(protectedSource, '\\[', '\\]', true, false, store);
    protectedSource = protectDelimited(protectedSource, '\\(', '\\)', false, false, store);
    protectedSource = protectedSource.replace(
      /\\begin\{([A-Za-z][A-Za-z0-9*]*)\}[\s\S]*?\\end\{\1\}/g,
      function (environment) {
        return store('\\[\n' + environment + '\n\\]');
      }
    );
    protectedSource = protectDelimited(protectedSource, '$', '$', false, true, store);
    protectedSource = restoreRaw(protectedSource, code.prefix, code.values);

    return {
      markdown: protectedSource,
      prefix: prefix,
      expressions: expressions
    };
  }

  function escapeMathForHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      }[character];
    });
  }

  function restoreMath(html, protectedDocument) {
    var restored = String(html || '');
    protectedDocument.expressions.forEach(function (expression, index) {
      restored = restored
        .split(tokenFor(protectedDocument.prefix, index))
        .join(escapeMathForHtml(expression));
    });
    return restored;
  }

  function render(markdown, marked, purifier) {
    if (!marked || typeof marked.parse !== 'function' || !purifier || typeof purifier.sanitize !== 'function') {
      throw new Error('Markdown 安全渲染组件尚未加载，请稍后重试。');
    }
    var protectedDocument = protectMath(markdown);
    if (typeof marked.setOptions === 'function') marked.setOptions({ gfm: true, breaks: false });
    var html = marked.parse(protectedDocument.markdown);
    html = restoreMath(html, protectedDocument);
    return purifier.sanitize(html);
  }

  return {
    protectMath: protectMath,
    restoreMath: restoreMath,
    render: render
  };
}));
