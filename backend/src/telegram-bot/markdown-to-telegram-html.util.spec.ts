import { markdownToTelegramHtml } from './markdown-to-telegram-html.util';

describe('markdownToTelegramHtml', () => {
  it('escapes raw HTML-special characters', () => {
    expect(markdownToTelegramHtml('5 < 10 & "ok" > done')).toBe('5 &lt; 10 &amp; "ok" &gt; done');
  });

  it('converts bold/italic/strikethrough', () => {
    expect(markdownToTelegramHtml('**жирный**')).toBe('<b>жирный</b>');
    expect(markdownToTelegramHtml('__тоже жирный__')).toBe('<b>тоже жирный</b>');
    expect(markdownToTelegramHtml('*курсив*')).toBe('<i>курсив</i>');
    expect(markdownToTelegramHtml('_тоже курсив_')).toBe('<i>тоже курсив</i>');
    expect(markdownToTelegramHtml('~~зачёркнутый~~')).toBe('<s>зачёркнутый</s>');
  });

  it('converts links', () => {
    expect(markdownToTelegramHtml('[текст](https://example.com/path)')).toBe('<a href="https://example.com/path">текст</a>');
  });

  it('does not touch markdown syntax inside inline code', () => {
    expect(markdownToTelegramHtml('`*not bold*`')).toBe('<code>*not bold*</code>');
  });

  it('does not touch markdown syntax inside fenced code blocks', () => {
    expect(markdownToTelegramHtml('```\n**not bold** _not italic_\n```')).toBe('<pre>\n**not bold** _not italic_\n</pre>');
  });

  it('combines several formatting rules in one string', () => {
    expect(markdownToTelegramHtml('**Важно**: зайдите по [ссылке](https://t.me/x) и введите `token`')).toBe(
      '<b>Важно</b>: зайдите по <a href="https://t.me/x">ссылке</a> и введите <code>token</code>',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(markdownToTelegramHtml('  hello  \n')).toBe('hello');
  });
});
