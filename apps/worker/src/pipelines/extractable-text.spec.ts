import type { ParsedBlock } from './mineru.client';
import {
  assertHasExtractableText,
  hasExtractableText,
  NO_EXTRACTABLE_TEXT_MSG,
} from './extractable-text';

describe('assertHasExtractableText', () => {
  it('纯 figure 抛错', () => {
    expect(() =>
      assertHasExtractableText({
        blocks: [{ type: 'figure', text: 'img/a.png', page: 1 }],
      }),
    ).toThrow(NO_EXTRACTABLE_TEXT_MSG);
  });

  it('空 blocks 抛错', () => {
    expect(() => assertHasExtractableText({ blocks: [] })).toThrow(NO_EXTRACTABLE_TEXT_MSG);
  });

  it('纯 Markdown 图片抛错', () => {
    const blocks: ParsedBlock[] = [
      { type: 'paragraph', text: '![](https://example.com/a.png)', page: 1 },
      { type: 'paragraph', text: '![图](./scan.jpg)', page: 1 },
    ];
    expect(hasExtractableText({ blocks })).toBe(false);
    expect(() => assertHasExtractableText({ blocks })).toThrow(NO_EXTRACTABLE_TEXT_MSG);
  });

  it('空 HTML 剥标签后抛错', () => {
    const blocks: ParsedBlock[] = [
      { type: 'paragraph', text: '<img src="a.png"><img src="b.jpg">', page: 1 },
    ];
    expect(() => assertHasExtractableText({ blocks })).toThrow(NO_EXTRACTABLE_TEXT_MSG);
  });

  it('含段落通过', () => {
    expect(() =>
      assertHasExtractableText({
        blocks: [
          { type: 'figure', text: 'img/a.png', page: 1 },
          { type: 'paragraph', text: '差旅住宿标准', page: 1 },
        ],
      }),
    ).not.toThrow();
  });

  it('含表格单元格文字通过', () => {
    expect(() =>
      assertHasExtractableText({
        blocks: [{ type: 'table', text: '<table><tr><td>限额</td></tr></table>', page: 1 }],
      }),
    ).not.toThrow();
  });
});
