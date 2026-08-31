import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Element, Parent, Text } from 'hast';

/** 把正文中的 [n] 引用角标渲染为上标徽章（代码块内不处理） */
function rehypeCitation() {
  return (tree: Parent) => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index == null) return;
      if ((parent as Element).tagName === 'code' || (parent as Element).tagName === 'pre') return;
      if (!/\[\d+\]/.test(node.value)) return;
      const children = node.value.split(/(\[\d+\])/g).map((part: string): Text | Element => {
        const m = part.match(/^\[(\d+)\]$/);
        if (m) {
          return {
            type: 'element',
            tagName: 'sup',
            properties: { className: ['citation-ref'] },
            children: [{ type: 'text', value: m[1] }],
          };
        }
        return { type: 'text', value: part };
      });
      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}

/** AI 回答的 Markdown 渲染：GFM 表格/删除线 + 引用角标徽章 + 定制样式 */
export default function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none text-ink-900 dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold prose-p:my-2 prose-p:leading-6 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-strong:text-ink-900 dark:prose-strong:text-ink-900 prose-hr:my-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCitation]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-brand-600 underline underline-offset-2">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="my-0 w-full text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-subtle px-3 py-2 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>,
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return (
                <code className={`${className ?? ''} block text-xs leading-5`} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-subtle px-1 py-0.5 text-[0.85em] text-brand-700 dark:text-brand-700" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-lg bg-ink-900 p-3 text-stone-100 dark:bg-black/40">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
