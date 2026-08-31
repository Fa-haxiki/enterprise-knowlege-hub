#!/usr/bin/env node
/**
 * 入库吞吐压测：并发上传同一测试文件 N 份，轮询至 READY，统计端到端耗时。
 *
 * 用法：
 *   TOKEN=<jwt> node scripts/benchmark/ingest-bench.mjs [份数] [并发数]
 *
 * 环境变量：
 *   API_BASE      默认 http://localhost:8080/api/v1
 *   WORKSPACE_ID  目标空间
 *   TEST_FILE     测试文件路径（默认 /tmp/ekh-test-docs/差旅费管理办法.pdf）
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const API_BASE = process.env.API_BASE ?? 'http://localhost:8080/api/v1';
const TOKEN = process.env.TOKEN;
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? '12613773-2740-4332-ae0f-f88cd27178e0';
const TEST_FILE = process.env.TEST_FILE ?? '/tmp/ekh-test-docs/差旅费管理办法.pdf';
const TOTAL = parseInt(process.argv[2] ?? '5', 10);
const CONCURRENCY = parseInt(process.argv[3] ?? '3', 10);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

if (!TOKEN) {
  console.error('请设置 TOKEN 环境变量');
  process.exit(1);
}

const fileBuf = readFileSync(TEST_FILE);
const fileName = basename(TEST_FILE);

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...options.headers,
    },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`${path} -> ${data.code} ${data.message}`);
  return data.data;
}

async function uploadOne(seq) {
  const t0 = Date.now();
  const init = await api(`/workspaces/${WORKSPACE_ID}/documents/upload-init`, {
    method: 'POST',
    body: JSON.stringify({
      filename: `压测-${seq}-${fileName}`,
      file_size: fileBuf.length,
      mime_type: 'application/pdf',
    }),
  });

  // 单分片直传（测试文件 < part_size）
  const putRes = await fetch(init.part_urls[0], { method: 'PUT', body: fileBuf });
  if (!putRes.ok) throw new Error(`part upload ${putRes.status}`);

  await api(`/documents/${init.document_id}/upload-complete`, {
    method: 'POST',
    body: JSON.stringify({
      upload_id: init.upload_id,
      part_count: init.part_urls.length,
    }),
  });

  // 轮询至 READY / FAILED
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const doc = await api(`/documents/${init.document_id}`);
    if (doc.status === 'READY') return { seq, ms: Date.now() - t0, ok: true };
    if (doc.status === 'FAILED') return { seq, ms: Date.now() - t0, ok: false };
    if (Date.now() - t0 > POLL_TIMEOUT_MS) return { seq, ms: Date.now() - t0, ok: false, timeout: true };
  }
}

async function main() {
  console.log(`入库压测: ${TOTAL} 份 × 并发 ${CONCURRENCY}，文件=${fileName} (${(fileBuf.length / 1024).toFixed(0)}KB)`);
  const results = [];
  const t0 = Date.now();
  const queue = Array.from({ length: TOTAL }, (_, i) => i + 1);

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const seq = queue.shift();
      if (seq === undefined) break;
      try {
        const r = await uploadOne(seq);
        results.push(r);
        console.log(`  #${seq} ${r.ok ? 'READY' : 'FAILED'} ${(r.ms / 1000).toFixed(1)}s`);
      } catch (e) {
        results.push({ seq, ms: Date.now() - t0, ok: false });
        console.log(`  #${seq} ERROR ${e.message}`);
      }
    }
  });
  await Promise.all(workers);

  const ok = results.filter((r) => r.ok);
  const wallMs = Date.now() - t0;
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  console.log('\n===== 入库压测结果 =====');
  console.log(`总数: ${results.length}  成功: ${ok.length}  失败: ${results.length - ok.length}`);
  console.log(`总耗时: ${(wallMs / 1000).toFixed(1)}s  吞吐: ${(ok.length / (wallMs / 60000)).toFixed(2)} 份/分`);
  if (times.length > 0) {
    console.log(`单份耗时 s: min=${(times[0] / 1000).toFixed(1)} P50=${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)} max=${(times[times.length - 1] / 1000).toFixed(1)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
