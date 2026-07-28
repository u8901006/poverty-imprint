import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS_DIR = resolve(process.cwd(), 'docs');
const REPORT_DATE = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
const INPUT = resolve(process.cwd(), 'papers.json');
const OUTPUT = resolve(DOCS_DIR, `poverty-${REPORT_DATE}.html`);

const BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const API_KEY = process.env.NVIDIA_API_KEY || '';
const MAX_TOKENS = Math.min(parseInt(process.env.NVIDIA_MAX_TOKENS || '16384', 10), 16384);
const TIMEOUT_MS = parseInt(process.env.NVIDIA_TIMEOUT_MS || '480000', 10);

const MODEL_CHAIN = ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-nano-30b-a3b'];

const SYSTEM_PROMPT = `你是一位專業的「貧窮印記」（Poverty Imprint）研究文獻分析師。你的專長涵蓋生物嵌入、壓力生理學、神經科學、表觀遺傳學、心理健康、社會決定因素與政策介入。

你的任務是：
1. 閱讀並分析提供的學術文獻
2. 將文獻按主題分類（每類至少1篇，最多10篇）
3. 為每篇文獻撰寫繁體中文摘要（150-250字）
4. 提取 PICO 元素
5. 評估臨床應用價值（high / medium / low）
6. 提取3-5個關鍵發現和3-5個關鍵詞
7. 撰寫200-300字的整體總結

分類建議（可根據文獻內容調整）：
- Biological Embedding & Stress Physiology（生物嵌入與壓力生理）
- Brain Development & Neuroscience（大腦發展與神經科學）
- Mental Health & Psychopathology（心理健康與精神病理）
- Epigenetics & Biological Aging（表觀遺傳與生物老化）
- Neighborhood & Social Determinants（社區與社會決定因素）
- Policy Interventions & Poverty Reduction（政策介入與扶貧效果）
- Cognition & Behavior（認知與行為）
- Intergenerational Transmission & Social Mobility（跨代傳遞與社會流動）

請嚴格以 JSON 格式回覆，不要使用 markdown code block，不要加任何前後說明文字。JSON 結構如下：

{"overall_summary_zh":"整體總結200-300字","categories":[{"name":"English Category Name","name_zh":"中文分類名稱","papers":[{"pmid":"PMID","title_en":"英文標題","title_zh":"中文標題翻譯","summary_zh":"繁體中文摘要150-250字","pico":{"population":"研究對象","intervention_exposure":"介入或暴露","comparison":"對照組","outcome":"研究結果"},"clinical_utility":"high或medium或low","key_findings":["發現1","發現2","發現3"],"keywords":["關鍵詞1","關鍵詞2","關鍵詞3"]}]}]}`;

function extractJson(text) {
  let cleaned = text.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    const substr = cleaned.substring(s, e + 1);
    try {
      return JSON.parse(substr);
    } catch {
      try {
        return JSON.parse(
          substr
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/"\s*\n\s*"/g, '"\n"')
        );
      } catch {
        return null;
      }
    }
  }
}

async function callNvidiaApi(messages) {
  for (const model of MODEL_CHAIN) {
    console.log(`Trying model: ${model}...`);
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: MAX_TOKENS,
          temperature: 1.0,
          top_p: 0.95,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`  Model ${model}: HTTP ${res.status} - ${errText.slice(0, 200)}`);
        continue;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        console.error(`  Model ${model}: empty response content`);
        continue;
      }
      console.log(`  Model ${model}: got response (${content.length} chars)`);
      return content;
    } catch (err) {
      console.error(`  Model ${model} failed: ${err.message}`);
    }
  }
  return null;
}

function buildUserPrompt(papers) {
  const paperTexts = papers.map((p, i) => {
    const parts = [`Paper ${i + 1}:`, `PMID: ${p.pmid}`, `Title: ${p.title}`];
    if (p.authors?.length) parts.push(`Authors: ${p.authors.join(', ')}`);
    if (p.journal) parts.push(`Journal: ${p.journal}`);
    if (p.pub_date) parts.push(`Date: ${p.pub_date}`);
    if (p.doi) parts.push(`DOI: ${p.doi}`);
    if (p.abstract) parts.push(`Abstract: ${p.abstract}`);
    return parts.join('\n');
  });
  return `以下共 ${papers.length} 篇文獻，請分析並分類：\n\n${paperTexts.join('\n\n---\n\n')}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateFallbackHtml(papers, date) {
  const paperCards = papers.map((p, idx) => {
    const authors = (p.authors || []).slice(0, 4).join(', ');
    const delay = Math.min(idx * 0.08, 2);
    return `
    <div class="paper-card" data-pmid="${escapeHtml(p.pmid)}" style="animation-delay:${delay}s">
      <div class="paper-meta">
        <span class="paper-journal">${escapeHtml(p.journal || '')}</span>
        <span class="paper-date">${escapeHtml(p.pub_date || '')}</span>
        ${p.doi ? `<a class="paper-doi" href="https://doi.org/${encodeURIComponent(p.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
      </div>
      <h3 class="paper-title">${escapeHtml(p.title)}</h3>
      ${authors ? `<p class="paper-authors">${escapeHtml(authors)}${p.authors?.length > 4 ? ' et al.' : ''}</p>` : ''}
      ${p.abstract ? `<p class="paper-abstract">${escapeHtml(p.abstract.slice(0, 500))}${p.abstract.length > 500 ? '...' : ''}</p>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Poverty Imprint 研究日報 - ${escapeHtml(date)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${getBaseCss()}</style>
</head>
<body>
<div class="container">
  <header class="report-header">
    <div class="logo">&#128300;</div>
    <h1>Poverty Imprint 研究日報</h1>
    <p class="subtitle">貧窮印記：跨領域研究每日精選</p>
    <p class="date">${escapeHtml(date)}</p>
    <div class="stats">
      <span class="stat-item">&#128196; ${papers.length} 篇文獻</span>
      <span class="stat-item">&#9888; AI 分析暫時無法使用，僅顯示原始摘要</span>
    </div>
  </header>
  <section class="papers-section">
    <h2>&#128209; 文獻列表</h2>
    ${paperCards || '<p class="no-papers">本日無新文獻</p>'}
  </section>
  ${getFooterHtml()}
</div>
</body>
</html>`;
}

function getBaseCss() {
  return `
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;--accent-light:#f4e4d4}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at top,#fff6ea 0%,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:'Inter','Noto Serif TC',serif;line-height:1.7;padding:2rem 1rem;min-height:100vh}
.container{max-width:880px;margin:0 auto}
.report-header{text-align:center;margin-bottom:2.5rem;padding-bottom:1.5rem;border-bottom:2px solid var(--line)}
.logo{font-size:3rem;margin-bottom:0.5rem}
h1{font-size:1.8rem;font-weight:700;color:var(--accent);font-family:'Noto Serif TC',serif;margin-bottom:0.25rem}
h2{font-size:1.3rem;font-weight:600;color:var(--accent);margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:1px solid var(--line)}
h3{font-size:1.1rem;font-weight:600;line-height:1.5;margin-bottom:0.5rem}
.subtitle{color:var(--muted);font-size:0.95rem}
.date{font-size:1.1rem;font-weight:600;color:var(--muted);margin-top:0.5rem}
.stats{display:flex;gap:1.5rem;justify-content:center;margin-top:1rem;flex-wrap:wrap}
.stat-item{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:0.5rem 1rem;font-size:0.85rem;color:var(--muted)}
.paper-card{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:1.5rem;margin-bottom:1.5rem;animation:fadeIn 0.6s ease-out both}
.paper-card:nth-child(n){animation-delay:calc(var(--idx,0)*0.08s)}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.paper-meta{display:flex;gap:0.75rem;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;font-size:0.8rem}
.paper-journal{background:var(--accent);color:#fff;padding:0.15rem 0.6rem;border-radius:4px;font-weight:500;font-size:0.75rem}
.paper-date{color:var(--muted)}
.paper-doi{color:var(--accent);text-decoration:none;font-weight:500;border:1px solid var(--accent-soft);padding:0.1rem 0.5rem;border-radius:4px;font-size:0.75rem}
.paper-doi:hover{background:var(--accent-soft)}
.paper-title{color:var(--text);font-family:'Noto Serif TC',serif;font-size:1.05rem;font-weight:600;line-height:1.6}
.paper-authors{color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem}
.paper-abstract{color:var(--text);font-size:0.9rem;line-height:1.8;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--line)}
.no-papers{color:var(--muted);text-align:center;padding:3rem 1rem;font-size:1rem}
.overall-summary{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1.5rem;margin-bottom:2rem;line-height:1.9;font-size:0.95rem}
.topic-distribution{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1.5rem;margin-bottom:2rem}
.topic-row{display:flex;align-items:center;gap:0.75rem;margin-bottom:0.6rem}
.topic-label{min-width:180px;font-size:0.85rem;color:var(--text);text-align:right;flex-shrink:0}
.topic-bar{flex:1;background:var(--bg);border-radius:6px;overflow:hidden;height:24px}
.topic-bar-fill{background:linear-gradient(90deg,var(--accent),#b36b3f);height:100%;border-radius:6px;display:flex;align-items:center;padding-left:0.5rem;color:#fff;font-size:0.75rem;font-weight:500;min-width:0;transition:width 0.6s ease}
.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin:1rem 0}
.pico-item{background:var(--bg);border-radius:6px;padding:0.75rem}
.pico-label{font-size:0.7rem;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.25rem}
.pico-value{font-size:0.85rem;color:var(--text);line-height:1.5}
.badge{display:inline-block;padding:0.2rem 0.7rem;border-radius:12px;font-size:0.75rem;font-weight:600;margin-top:0.5rem}
.badge-high{background:#d4edda;color:#155724}
.badge-medium{background:#fff3cd;color:#856404}
.badge-low{background:#e2e3e5;color:#383d41}
.findings{margin:0.75rem 0;padding-left:1.25rem}
.findings li{font-size:0.88rem;color:var(--text);line-height:1.7;margin-bottom:0.3rem}
.keywords{display:flex;flex-wrap:wrap;gap:0.3rem;margin-top:0.75rem}
.keyword-pill{background:var(--accent-soft);color:var(--accent);padding:0.15rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:500}
.category-section{margin-bottom:2.5rem}
.category-title{font-size:1.15rem;font-weight:600;color:var(--accent);margin-bottom:1rem;padding-bottom:0.4rem;border-bottom:2px solid var(--accent-soft);display:flex;align-items:center;gap:0.5rem}
.category-count{background:var(--accent-soft);color:var(--accent);font-size:0.75rem;padding:0.15rem 0.5rem;border-radius:10px;font-weight:600}
.report-footer{margin-top:3rem;padding-top:2rem;border-top:2px solid var(--line);text-align:center}
.footer-links{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-bottom:1rem}
.footer-btn{display:inline-flex;align-items:center;gap:0.4rem;padding:0.6rem 1.2rem;border-radius:8px;text-decoration:none;font-size:0.9rem;font-weight:500;transition:all 0.2s;border:1px solid var(--line);color:var(--text);background:var(--surface)}
.footer-btn:hover{background:var(--accent-soft);border-color:var(--accent)}
.footer-btn.coffee{background:#ffdd00;border-color:#e6c800;color:#2b2118}
.footer-btn.coffee:hover{background:#ffe533}
.footer-note{color:var(--muted);font-size:0.8rem;margin-top:0.75rem}
@media(max-width:640px){.pico-grid{grid-template-columns:1fr}.topic-row{flex-direction:column;align-items:flex-start}.topic-label{text-align:left;min-width:auto}.stats{flex-direction:column;align-items:center}.footer-links{flex-direction:column;align-items:center}}
`;
}

function getFooterHtml() {
  return `
  <footer class="report-footer">
    <div class="footer-links">
      <a href="https://www.leepsyclinic.com/" class="footer-btn" target="_blank" rel="noopener">&#127973; 李政洋身心診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" class="footer-btn" target="_blank" rel="noopener">&#128236; 訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" class="footer-btn coffee" target="_blank" rel="noopener">&#9749; Buy me a coffee</a>
    </div>
    <p class="footer-note">Poverty Imprint Research Daily &mdash; Powered by NVIDIA Nemotron</p>
  </footer>`;
}

function generateAnalyzedHtml(analysis, papers, date) {
  const allPapersMap = new Map(papers.map((p) => [p.pmid, p]));
  const categories = analysis.categories || [];
  const totalCount = categories.reduce((s, c) => s + (c.papers?.length || 0), 0);
  const maxCatCount = Math.max(...categories.map((c) => c.papers?.length || 0), 1);

  const topicBars = categories
    .map((c) => {
      const cnt = c.papers?.length || 0;
      const pct = Math.round((cnt / maxCatCount) * 100);
      return `<div class="topic-row">
  <span class="topic-label">${escapeHtml(c.name_zh || c.name)}</span>
  <div class="topic-bar"><div class="topic-bar-fill" style="width:${pct}%">${cnt} 篇</div></div>
</div>`;
    })
    .join('\n');

  const categorySections = categories
    .map((cat, ci) => {
      const cards = (cat.papers || [])
        .map((p, pi) => {
          const orig = allPapersMap.get(p.pmid);
          const delay = Math.min((ci * 5 + pi) * 0.08, 3);
          const utility = (p.clinical_utility || 'low').toLowerCase();
          const utilityClass = utility === 'high' ? 'badge-high' : utility === 'medium' ? 'badge-medium' : 'badge-low';
          const utilityLabel = utility === 'high' ? '臨床價值：高' : utility === 'medium' ? '臨床價值：中' : '臨床價值：低';
          const findings = (p.key_findings || [])
            .map((f) => `<li>${escapeHtml(f)}</li>`)
            .join('');
          const keywords = (p.keywords || [])
            .map((k) => `<span class="keyword-pill">${escapeHtml(k)}</span>`)
            .join('');
          const picoHtml = p.pico
            ? `<div class="pico-grid">
  <div class="pico-item"><div class="pico-label">Population</div><div class="pico-value">${escapeHtml(p.pico.population || 'N/A')}</div></div>
  <div class="pico-item"><div class="pico-label">Intervention / Exposure</div><div class="pico-value">${escapeHtml(p.pico.intervention_exposure || 'N/A')}</div></div>
  <div class="pico-item"><div class="pico-label">Comparison</div><div class="pico-value">${escapeHtml(p.pico.comparison || 'N/A')}</div></div>
  <div class="pico-item"><div class="pico-label">Outcome</div><div class="pico-value">${escapeHtml(p.pico.outcome || 'N/A')}</div></div>
</div>`
            : '';

          return `
  <div class="paper-card" data-pmid="${escapeHtml(p.pmid)}" style="animation-delay:${delay}s">
    <div class="paper-meta">
      <span class="paper-journal">${escapeHtml(orig?.journal || '')}</span>
      <span class="paper-date">${escapeHtml(orig?.pub_date || '')}</span>
      ${orig?.doi ? `<a class="paper-doi" href="https://doi.org/${encodeURIComponent(orig.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
      <span class="badge ${utilityClass}">${utilityLabel}</span>
    </div>
    <h3 class="paper-title">${escapeHtml(p.title_en || orig?.title || '')}</h3>
    <p class="paper-title" style="font-size:0.95rem;color:var(--muted);margin-top:0.2rem">${escapeHtml(p.title_zh || '')}</p>
    ${orig?.authors?.length ? `<p class="paper-authors">${escapeHtml(orig.authors.slice(0, 4).join(', '))}${orig.authors.length > 4 ? ' et al.' : ''}</p>` : ''}
    ${p.summary_zh ? `<p class="paper-abstract">${escapeHtml(p.summary_zh)}</p>` : ''}
    ${picoHtml}
    ${findings ? `<ul class="findings">${findings}</ul>` : ''}
    ${keywords ? `<div class="keywords">${keywords}</div>` : ''}
  </div>`;
        })
        .join('');

      return `
  <section class="category-section">
    <div class="category-title">${escapeHtml(cat.name_zh || cat.name)} <span class="category-count">${cat.papers?.length || 0} 篇</span></div>
    ${cards}
  </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Poverty Imprint 研究日報 - ${escapeHtml(date)}</title>
<meta name="description" content="貧窮印記研究每日文獻精選摘要 ${escapeHtml(date)}">
<meta property="og:title" content="Poverty Imprint 研究日報 - ${escapeHtml(date)}">
<meta property="og:description" content="貧窮印記：跨領域研究每日精選摘要">
<meta property="og:type" content="article">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${getBaseCss()}</style>
</head>
<body>
<div class="container">
  <header class="report-header">
    <div class="logo">&#128300;</div>
    <h1>Poverty Imprint 研究日報</h1>
    <p class="subtitle">貧窮印記：跨領域研究每日精選</p>
    <p class="date">${escapeHtml(date)}</p>
    <div class="stats">
      <span class="stat-item">&#128196; ${totalCount} 篇文獻</span>
      <span class="stat-item">&#128193; ${categories.length} 個分類</span>
    </div>
  </header>

  <section class="overall-summary">
    <h2>&#128202; 今日總覽</h2>
    <p>${escapeHtml(analysis.overall_summary_zh || '')}</p>
  </section>

  <section class="topic-distribution">
    <h2>&#128200; 主題分布</h2>
    ${topicBars}
  </section>

  <section class="papers-section">
    <h2>&#128209; 文獻分析</h2>
    ${categorySections}
  </section>

  ${getFooterHtml()}
</div>
</body>
</html>`;
}

async function main() {
  if (!API_KEY) {
    console.error('NVIDIA_API_KEY is not set');
    process.exit(1);
  }

  if (!existsSync(INPUT)) {
    console.error('papers.json not found');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(INPUT, 'utf-8'));
  const papers = data.papers || [];
  const date = data.date || REPORT_DATE;

  console.log(`Generating report for ${date} with ${papers.length} papers`);

  if (papers.length === 0) {
    const html = generateAnalyzedHtml(
      { overall_summary_zh: '本日無符合條件的新文獻。系統已搜尋 PubMed 中與貧窮印記相關的多個主題，包括生物嵌入、大腦發展、心理健康、表觀遺傳、社區與政策介入等領域。請明日再查看更新。', categories: [] },
      [],
      date,
    );
    writeFileSync(OUTPUT, html, 'utf-8');
    console.log(`Empty report saved to ${OUTPUT}`);
    return;
  }

  const userPrompt = buildUserPrompt(papers);
  console.log(`Sending ${papers.length} papers to NVIDIA Nemotron (prompt: ${userPrompt.length} chars)...`);

  const aiResponse = await callNvidiaApi([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]);

  if (aiResponse) {
    const analysis = extractJson(aiResponse);
    if (analysis && analysis.categories) {
      console.log(`AI analysis successful: ${analysis.categories.length} categories`);
      const html = generateAnalyzedHtml(analysis, papers, date);
      writeFileSync(OUTPUT, html, 'utf-8');
      console.log(`Report saved to ${OUTPUT}`);
      return;
    } else {
      console.error('AI response JSON parsing failed, using fallback');
    }
  }

  console.log('Generating fallback HTML without AI analysis...');
  const html = generateFallbackHtml(papers, date);
  writeFileSync(OUTPUT, html, 'utf-8');
  console.log(`Fallback report saved to ${OUTPUT}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
