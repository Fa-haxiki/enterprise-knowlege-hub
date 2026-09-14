import { ConfigService } from '@nestjs/config';
import { Chunker } from './chunker';
import type { ParsedBlock } from './mineru.client';

function makeChunker(parent = 20, child = 8, overlap = 2): Chunker {
  const values: Record<string, number> = {
    'rag.parentChunkSize': parent,
    'rag.childChunkSize': child,
    'rag.childChunkOverlap': overlap,
  };
  return new Chunker({ get: (key: string) => values[key] } as ConfigService);
}

describe('Chunker parent-child', () => {
  it('按标题切父块，标题本身不进正文', () => {
    const blocks: ParsedBlock[] = [
      { type: 'heading', level: 1, text: '薪资', page: 1 },
      { type: 'paragraph', text: '段A内容', page: 1 },
      { type: 'heading', level: 2, text: '加班', page: 1 },
      { type: 'paragraph', text: '段C内容', page: 2 },
    ];
    const drafts = makeChunker(64, 64, 0).chunk(blocks);
    const parents = drafts.filter((d) => d.role === 'parent');
    expect(parents).toHaveLength(2);
    expect(parents[0].content).toBe('段A内容');
    expect(parents[0].headingPath).toEqual(['薪资']);
    expect(parents[1].content).toBe('段C内容');
    expect(parents[1].headingPath).toEqual(['薪资', '加班']);
    expect(parents[1].refs.page).toBe(2);
  });

  it('超长节按段落切多个父块且无 overlap', () => {
    // parentMax = 8 * 1.5 = 12 字符
    const blocks: ParsedBlock[] = [
      { type: 'heading', level: 1, text: '章', page: 1 },
      { type: 'paragraph', text: 'AAAAAAAAAA', page: 1 },
      { type: 'paragraph', text: 'BBBBBBBBBB', page: 1 },
    ];
    const drafts = makeChunker(8, 64, 0).chunk(blocks);
    const parents = drafts.filter((d) => d.role === 'parent');
    expect(parents).toHaveLength(2);
    expect(parents[0].content).toBe('AAAAAAAAAA');
    expect(parents[1].content).toBe('BBBBBBBBBB');
    expect(parents[1].content.includes('AAA')).toBe(false);
  });

  it('整表单独成父块，不与前后段落合并', () => {
    const blocks: ParsedBlock[] = [
      { type: 'heading', level: 1, text: '制度', page: 1 },
      { type: 'paragraph', text: '前文', page: 1 },
      { type: 'table', text: '<table><tr><td>单元格</td></tr></table>', page: 3, bbox: [0, 0, 1, 1] },
      { type: 'paragraph', text: '后文', page: 4 },
    ];
    const drafts = makeChunker(64, 64, 0).chunk(blocks);
    const parents = drafts.filter((d) => d.role === 'parent');
    expect(parents).toHaveLength(3);
    expect(parents[1].content).toContain('<table>');
    expect(parents[1].refs.page).toBe(3);
    expect(parents[1].refs.bbox).toEqual([0, 0, 1, 1]);
    expect(parents[0].content).toBe('前文');
    expect(parents[2].content).toBe('后文');
  });

  it('短父块只产 1 个等长子块', () => {
    const blocks: ParsedBlock[] = [{ type: 'paragraph', text: '短文', page: 1 }];
    const drafts = makeChunker(64, 64, 8).chunk(blocks);
    const parents = drafts.filter((d) => d.role === 'parent');
    const children = drafts.filter((d) => d.role === 'child');
    expect(parents).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(children[0].content).toBe(parents[0].content);
    expect(children[0].parentDraftId).toBe(parents[0].draftId);
  });

  it('长父块切子块并带 overlap', () => {
    // childMax = 8 * 1.5 = 12
    const blocks: ParsedBlock[] = [
      { type: 'paragraph', text: 'AAAAAAAAAA', page: 1 },
      { type: 'paragraph', text: 'BBBBBBBBBB', page: 1 },
    ];
    const drafts = makeChunker(64, 8, 2).chunk(blocks);
    const parents = drafts.filter((d) => d.role === 'parent');
    const children = drafts.filter((d) => d.role === 'child');
    expect(parents).toHaveLength(1);
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children[1].content.startsWith(children[0].content.slice(-3))).toBe(true);
    expect(children.every((c) => c.parentDraftId === parents[0].draftId)).toBe(true);
  });

  it('跳过 figure，不产出空父块', () => {
    const blocks: ParsedBlock[] = [
      { type: 'figure', text: 'img/a.png', page: 1 },
      { type: 'paragraph', text: '有字', page: 1 },
      { type: 'figure', text: 'img/b.png', page: 2 },
    ];
    const drafts = makeChunker().chunk(blocks);
    expect(drafts.filter((d) => d.role === 'parent')).toHaveLength(1);
    expect(drafts.some((d) => d.content.includes('png'))).toBe(false);
  });
});
