'use strict';

var assert = require('assert');
var mathMarkdown = require('../ui/math-markdown.js');

var markdown = [
  '行内公式 $x_1$ 与 \\(y_2\\)。',
  '',
  '$$',
  '\\begin{aligned}',
  '',
  'a&=b\\\\',
  '',
  'b&=c',
  '\\end{aligned}',
  '$$',
  '',
  '`$code_is_not_math$`',
  '',
  '```latex',
  '$$\\begin{cases}x&=1\\end{cases}$$',
  '```',
  '',
  '\\begin{cases}',
  '0,&x<0\\\\',
  '1,&x\\ge0',
  '\\end{cases}'
].join('\n');

var protectedDocument = mathMarkdown.protectMath(markdown);
assert.strictEqual(protectedDocument.expressions.length, 4);
assert.ok(protectedDocument.markdown.indexOf('`$code_is_not_math$`') !== -1);
assert.ok(protectedDocument.markdown.indexOf('```latex') !== -1);
assert.ok(protectedDocument.expressions.some(function (value) {
  return value.indexOf('\\begin{aligned}') !== -1 && value.indexOf('\n\na&=b') !== -1;
}));
assert.ok(protectedDocument.expressions.some(function (value) {
  return value.indexOf('\\[\n\\begin{cases}') === 0;
}));

var marked = {
  options: null,
  setOptions: function (options) {
    this.options = options;
  },
  parse: function (source) {
    return '<p>' + source.replace(/\n/g, '<br>') + '</p>';
  }
};
var purifier = {
  sanitize: function (html) {
    return html;
  }
};
var rendered = mathMarkdown.render(markdown, marked, purifier);
var alignedStart = rendered.indexOf('\\begin{aligned}');
var alignedEnd = rendered.indexOf('\\end{aligned}');
var alignedHtml = rendered.slice(alignedStart, alignedEnd);

assert.deepStrictEqual(marked.options, { gfm: true, breaks: false });
assert.ok(alignedStart !== -1 && alignedEnd !== -1);
assert.ok(alignedHtml.indexOf('<br>') === -1);
assert.ok(alignedHtml.indexOf('a&amp;=b') !== -1);
assert.ok(rendered.indexOf('`$code_is_not_math$`') !== -1);

var escaped = mathMarkdown.render(
  '$x<y & z>0$',
  marked,
  purifier
);
assert.ok(escaped.indexOf('$x&lt;y &amp; z&gt;0$') !== -1);
assert.ok(escaped.indexOf('$x<y & z>0$') === -1);

console.log('math-markdown tests: OK');
