#!/usr/bin/env node
/**
 * 问答链路压测：N 并发用户轮询提问，统计首 Token 延迟与总延迟。
 *
 * 用法：
 *   TOKEN=<jwt> node scripts/benchmark/chat-bench.mjs [并发数] [每用户请求数]
 *
 * 环境变量：
 *   API_BASE   默认 http://localhost:8080/api/v1
 *   WORKSPACE_ID  目标空间（默认采购部测试空间）
 */

const API_BASE = process.env.API_BASE ?? 'http://localhost:8080/api/v1';
const TOKEN = process.env.TOKEN;
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? '12613773-2740-4332-ae0f-f88cd27178e0';
const CONCURRENCY = parseInt(process.argv[2] ?? '50', 10);
const REQUESTS_PER_USER = parseInt(process.argv[3] ?? '2', 10);

const QUESTIONS = [
  '差旅住宿一线城市每晚上限多少？',
  '出差交通费如何报销？',
  '员工请假审批流程是什么？',
  '采购申请需要哪些审批？',
  '加班调休规则是什么？',
  '报销发票有什么要求？',
  '出差补贴标准是多少？',
  '合同审批流程是怎样的？',
];

if (!TOKEN) {
  console.error('请设置 TOKEN 环境变量（JWT access token）');
  process.exit(1);
}

async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`login failed: ${data.message}`);
  return data.data.access_token;
}

/** 单次问答：返回 { firstTokenMs, totalMs, ok } */
async function askOnce(token, question) {
  const t0 = Date.now();
  let firstTokenMs = null;
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ workspace_id: WORKSPACE_ID, query: question }),
    });
    if (!res.ok) return { firstTokenMs: null, totalMs: Date.now() - t0, ok: false, status: res.status };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (firstTokenMs === null && buf.includes('event: token')) {
        firstTokenMs = Date.now() - t0;
      }
      if (buf.includes('event: done') || buf.includes('event: error')) break;
    }
    return { firstTokenMs, totalMs: Date.now() - t0, ok: firstTokenMs !== null };
  } catch (e) {
    return { firstTokenMs: null, totalMs: Date.now() - t0, ok: false, error: e.message };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  console.log(`并发=${CONCURRENCY} 每用户请求=${REQUESTS_PER_USER} 目标=${API_BASE}`);

  // 每个并发虚拟用户独立登录（admin 单账号会互相顶 refresh token，用同一 token 即可——access token 无状态）
  const results = [];
  const t0 = Date.now();

  const workers = Array.from({ length: CONCURRENCY }, async (_, i) => {
    for (let j = 0; j < REQUESTS_PER_USER; j++) {
      const q = QUESTIONS[(i * REQUESTS_PER_USER + j) % QUESTIONS.length];
      results.push(await askOnce(TOKEN, q));
    }
  });
  await Promise.all(workers);

  const wallMs = Date.now() - t0;
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const firstTokens = ok.map((r) => r.firstTokenMs).sort((a, b) => a - b);
  const totals = ok.map((r) => r.totalMs).sort((a, b) => a - b);

  console.log('\n===== 压测结果 =====');
  console.log(`总请求: ${results.length}  成功: ${ok.length}  失败: ${failed.length}`);
  console.log(`总耗时: ${(wallMs / 1000).toFixed(1)}s  吞吐: ${((ok.length / wallMs) * 1000).toFixed(2)} req/s`);
  console.log(`首Token延迟 ms: P50=${percentile(firstTokens, 50)} P95=${percentile(firstTokens, 95)} P99=${percentile(firstTokens, 99)} max=${firstTokens[firstTokens.length - 1] ?? '-'}`);
  console.log(`总延迟    ms: P50=${percentile(totals, 50)} P95=${percentile(totals, 95)} P99=${percentile(totals, 99)} max=${totals[totals.length - 1] ?? '-'}`);
  if (failed.length > 0) {
    const byStatus = {};
    for (const f of failed) byStatus[f.status ?? f.error] = (byStatus[f.status ?? f.error] ?? 0) + 1;
    console.log('失败分布:', byStatus);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
