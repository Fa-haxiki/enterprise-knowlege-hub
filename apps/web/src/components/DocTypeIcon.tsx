/** 文档类型图标：折角文件造型 + 类型专属配色 + 扩展名角标，按文件扩展名区分 */
const TYPE_STYLES: Record<string, { color: string; label: string }> = {
  pdf: { color: '#E2574C', label: 'PDF' },
  doc: { color: '#2B579A', label: 'DOC' },
  docx: { color: '#2B579A', label: 'DOCX' },
  xls: { color: '#217346', label: 'XLS' },
  xlsx: { color: '#217346', label: 'XLSX' },
  ppt: { color: '#D2691E', label: 'PPT' },
  pptx: { color: '#D2691E', label: 'PPTX' },
  md: { color: '#7C3AED', label: 'MD' },
  markdown: { color: '#7C3AED', label: 'MD' },
  txt: { color: '#64748B', label: 'TXT' },
  html: { color: '#0E9F8A', label: 'HTML' },
  htm: { color: '#0E9F8A', label: 'HTML' },
};

const FALLBACK = { color: '#94A3B8', label: '' };

export function docExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

interface Props {
  /** 文件名（按扩展名决定图标样式） */
  title: string;
  size?: number;
  className?: string;
}

export default function DocTypeIcon({ title, size = 18, className }: Props) {
  const { color, label } = TYPE_STYLES[docExt(title)] ?? FALLBACK;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label={label || '文件'}
    >
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"
        fill={`${color}14`}
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {label && (
        <text
          x="12"
          y="17.6"
          textAnchor="middle"
          fontSize={label.length > 3 ? 4.8 : 6.4}
          fontWeight="700"
          fill={color}
          fontFamily="system-ui, -apple-system, sans-serif"
        >
          {label}
        </text>
      )}
    </svg>
  );
}
