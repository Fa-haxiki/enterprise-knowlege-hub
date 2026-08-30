import { Injectable } from '@nestjs/common';

/** 常见 Prompt 注入模式（中英文），按组管理便于维护与误报回退 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // 指令覆盖
  { name: 'ignore_instructions', re: /ignore\s+(all|any|previous|above|prior)[\s\w]*instructions/i },
  { name: 'disregard_instructions', re: /disregard\s+(all|previous|the\s+above)/i },
  { name: 'zh_ignore_instructions', re: /(忽略|无视|不要理会)(以上|之前|前面|上面|先前)(的)?(指令|指示|命令|要求|设定)/ },
  // 系统提示词提取
  { name: 'reveal_prompt', re: /(reveal|show|print|output|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)/i },
  { name: 'zh_reveal_prompt', re: /(输出|打印|重复|告诉|展示).{0,6}(你的|你的初始)?(系统)?(提示词|指令|设定)/ },
  // 角色覆盖
  { name: 'role_override', re: /(you\s+are\s+now|act\s+as\s+if\s+you\s+(are|were)|from\s+now\s+on\s+you\s+are)/i },
  { name: 'zh_role_override', re: /(从现在开始|从现在起)(你|你就是)(是|扮演|变成)/ },
  // 越狱框架
  { name: 'jailbreak_dan', re: /\b(DAN|do\s+anything\s+now|jailbreak)\b/i },
  { name: 'developer_mode', re: /(developer|debug|admin)\s+mode\s+(enabled|on|activate)/i },
];

@Injectable()
export class PromptInjectionService {
  /** 检测用户输入是否含注入意图；返回命中模式名（未命中返回 null） */
  detect(text: string): string | null {
    const normalized = text.replace(/\s+/g, ' ').trim();
    for (const p of INJECTION_PATTERNS) {
      if (p.re.test(normalized)) return p.name;
    }
    return null;
  }
}
