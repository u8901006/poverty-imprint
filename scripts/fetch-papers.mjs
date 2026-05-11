import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const DAYS = parseInt(process.env.PUBMED_DAYS || '7', 10);
const MAX_PAPERS = parseInt(process.env.PUBMED_MAX_PAPERS || '40', 10);
const REPORT_DATE = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);
const OUTPUT = resolve(process.cwd(), 'papers.json');
const DOCS_DIR = resolve(process.cwd(), 'docs');

const SEARCH_QUERIES = [
  `("Poverty"[Mesh] OR "Child Poverty"[Mesh] OR "Socioeconomic Factors"[Mesh] OR "Social Determinants of Health"[Mesh] OR poverty[tiab] OR "child poverty"[tiab] OR "socioeconomic disadvantage"[tiab] OR "socioeconomic status"[tiab] OR "neighborhood deprivation"[tiab] OR "income inequality"[tiab]) AND ("biological embedding"[tiab] OR "allostatic load"[tiab] OR "toxic stress"[tiab] OR cortisol[tiab] OR inflammation[tiab] OR "DNA methylation"[tiab] OR epigenetic*[tiab] OR telomere*[tiab] OR "biological aging"[tiab] OR "mental health"[tiab] OR depression[tiab])`,
  `("Poverty"[Mesh] OR poverty[tiab] OR "low income"[tiab] OR "socioeconomic status"[tiab] OR "socioeconomic disadvantage"[tiab]) AND ("brain development"[tiab] OR neurodevelopment[tiab] OR MRI[tiab] OR fMRI[tiab] OR "cortical thickness"[tiab] OR "functional connectivity"[tiab] OR "executive function"[tiab]) AND (child*[tiab] OR adolescen*[tiab] OR youth[tiab])`,
  `(poverty[tiab] OR "economic hardship"[tiab] OR "financial hardship"[tiab] OR "neighborhood disadvantage"[tiab]) AND (depression[tiab] OR anxiety[tiab] OR PTSD[tiab] OR trauma[tiab] OR ADHD[tiab] OR psychopathology[tiab] OR suicid*[tiab] OR "substance use"[tiab])`,
  `(poverty[tiab] OR "socioeconomic status"[tiab] OR "socioeconomic position"[tiab] OR "neighborhood deprivation"[tiab]) AND ("DNA methylation"[tiab] OR epigenetic*[tiab] OR "epigenetic clock"[tiab] OR "epigenetic age"[tiab] OR telomere*[tiab] OR "biological aging"[tiab] OR GrimAge[tiab] OR DunedinPACE[tiab])`,
  `(poverty[tiab] OR "low income"[tiab] OR "child poverty"[tiab]) AND ("cash transfer"[tiab] OR "earned income tax credit"[tiab] OR "child tax credit"[tiab] OR "minimum wage"[tiab] OR SNAP[tiab] OR "housing voucher"[tiab]) AND (health[tiab] OR "mental health"[tiab] OR "child development"[tiab] OR "brain development"[tiab])`,
  `("weathering"[tiab] OR "allostatic load"[tiab]) AND ("socioeconomic"[tiab] OR poverty[tiab] OR disadvantage[tiab])`,
  `("scarcity mindset"[tiab] OR "cognitive load of poverty"[tiab] OR "bandwidth tax"[tiab]) AND poverty[tiab]`,
];

function getDateRange() {
  const endDate = new Date(REPORT_DATE + 'T00:00:00Z');
  const startDate = new Date(endDate.getTime() - DAYS * 86400000);
  const fmt = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  return { start: fmt(startDate), end: fmt(endDate) };
}

function getSummarizedPmids() {
  const pmids = new Set();
  if (!existsSync(DOCS_DIR)) return pmids;
  const files = readdirSync(DOCS_DIR).filter((f) => /^poverty-\d{4}-\d{2}-\d{2}\.html$/.test(f));
  const now = new Date(REPORT_DATE + 'T00:00:00Z');
  const cutoff = new Date(now.getTime() - 7 * 86400000);
  for (const file of files) {
    const m = file.match(/poverty-(\d{4}-\d{2}-\d{2})\.html$/);
    if (!m) continue;
    const fd = new Date(m[1] + 'T00:00:00Z');
    if (fd < cutoff) continue;
    try {
      const html = readFileSync(resolve(DOCS_DIR, file), 'utf-8');
      for (const match of html.matchAll(/data-pmid="(\d+)"/g)) {
        pmids.add(match[1]);
      }
    } catch { /* skip unreadable */ }
  }
  return pmids;
}

async function esearch(query, dateRange) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: `${query} AND ("${dateRange.start}"[Date - Publication] : "${dateRange.end}"[Date - Publication])`,
    retmax: String(MAX_PAPERS),
    retmode: 'json',
    sort: 'pub_date',
  });
  const res = await fetch(`${ESEARCH_URL}?${params}`, {
    headers: { 'User-Agent': 'PovertyImprintBot/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`ESearch HTTP ${res.status}`);
  const data = await res.json();
  return data?.esearchresult?.idlist || [];
}

async function esummary(pmids) {
  if (pmids.length === 0) return {};
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'json',
  });
  const res = await fetch(`${ESUMMARY_URL}?${params}`, {
    headers: { 'User-Agent': 'PovertyImprintBot/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`ESummary HTTP ${res.status}`);
  const data = await res.json();
  return data?.result || {};
}

async function efetchAbstracts(pmids) {
  if (pmids.length === 0) return {};
  const abstracts = {};
  const batchSize = 50;
  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    const params = new URLSearchParams({
      db: 'pubmed',
      id: batch.join(','),
      rettype: 'abstract',
      retmode: 'xml',
    });
    const res = await fetch(`${EFETCH_URL}?${params}`, {
      headers: { 'User-Agent': 'PovertyImprintBot/1.0' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) continue;
    const xml = await res.text();
    const articles = xml.split('<PubmedArticle>').slice(1);
    for (const article of articles) {
      const pmidMatch = article.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      if (!pmidMatch) continue;
      const pmid = pmidMatch[1];
      const abstractParts = [];
      const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
      let absMatch;
      while ((absMatch = absRegex.exec(article)) !== null) {
        const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
        const text = absMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text) {
          abstractParts.push(labelMatch ? `${labelMatch[1]}: ${text}` : text);
        }
      }
      abstracts[pmid] = abstractParts.join(' ');
    }
    if (i + batchSize < pmids.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return abstracts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`Fetching papers for date: ${REPORT_DATE}`);
  console.log(`Date range: past ${DAYS} days, max ${MAX_PAPERS} papers`);

  const dateRange = getDateRange();
  console.log(`Date range: ${dateRange.start} - ${dateRange.end}`);

  const alreadyDone = getSummarizedPmids();
  console.log(`Already summarized PMIDs: ${alreadyDone.size}`);

  const allPmids = new Set();
  for (let i = 0; i < SEARCH_QUERIES.length; i++) {
    try {
      console.log(`Running search query ${i + 1}/${SEARCH_QUERIES.length}...`);
      const ids = await esearch(SEARCH_QUERIES[i], dateRange);
      for (const id of ids) allPmids.add(id);
      console.log(`  Found ${ids.length} PMIDs (total unique: ${allPmids.size})`);
    } catch (err) {
      console.error(`  Search query ${i + 1} failed: ${err.message}`);
    }
    if (i < SEARCH_QUERIES.length - 1) await sleep(400);
  }

  const newPmids = [...allPmids].filter((id) => !alreadyDone.has(id));
  console.log(`New PMIDs after dedup: ${newPmids.length}`);

  if (newPmids.length === 0) {
    writeFileSync(OUTPUT, JSON.stringify({ date: REPORT_DATE, count: 0, papers: [] }, null, 2));
    console.log('No new papers found');
    return;
  }

  const limitedPmids = newPmids.slice(0, MAX_PAPERS);
  console.log(`Fetching details for ${limitedPmids.length} papers...`);

  const [summaryData, abstracts] = await Promise.all([esummary(limitedPmids), efetchAbstracts(limitedPmids)]);

  const papers = limitedPmids
    .map((pmid) => {
      const info = summaryData[pmid];
      if (!info || !info.title) return null;
      return {
        pmid,
        title: info.title.replace(/<[^>]+>/g, '').trim(),
        authors: (info.authors || []).slice(0, 6).map((a) => a.name),
        journal: info.source || info.fulljournalname || '',
        pub_date: info.pubdate || '',
        volume: info.volume || '',
        issue: info.issue || '',
        pages: info.pages || '',
        doi: info.elocationid ? info.elocationid.replace(/^doi:\s*/i, '') : (info.articleids || []).find((a) => a.idtype === 'doi')?.value || '',
        abstract: abstracts[pmid] || '',
      };
    })
    .filter(Boolean);

  const result = { date: REPORT_DATE, count: papers.length, papers };
  writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`Saved ${papers.length} papers to ${OUTPUT}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeFileSync(OUTPUT, JSON.stringify({ date: REPORT_DATE, count: 0, papers: [], error: err.message }, null, 2));
  process.exit(0);
});
