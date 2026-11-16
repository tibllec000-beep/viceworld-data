// Robô que atualiza o catálogo de vídeos e a wiki do Vice World.
//
// Uso:
//   node update.mjs              -> vídeos + wiki
//   node update.mjs --wiki       -> só wiki
//   node update.mjs --videos     -> só vídeos
//   node update.mjs --assets     -> também copia o resultado para ../assets/data
//
// Variáveis de ambiente:
//   YOUTUBE_API_KEY    (obrigatória para vídeos) - chave da YouTube Data API v3
//   ANTHROPIC_API_KEY  (opcional) - traduz a wiki para todos os idiomas com o Claude.
//                      Sem ela, a wiki usa os textos manuais de wiki_manual.json
//                      (já escritos nos 15 idiomas).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "data");
const ASSETS = path.join(here, "..", "assets", "data");
const CACHE = path.join(here, "cache");
const config = readJson(path.join(here, "config.json"));
const manual = readJson(path.join(here, "wiki_manual.json"), {});
const args = new Set(process.argv.slice(2));
const doVideos = !args.has("--wiki");
const doWiki = !args.has("--videos");
const UA = { "User-Agent": "ViceWorldBot/1.0 (fan app content updater)" };

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
}
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- VÍDEOS

const GTA6 = /\bgta\s*-?\s*(6|vi)\b|gta6|grand theft auto (6|vi)\b/i;
const KEYWORDS = {
  easter_egg: /easter ?egg|彩蛋|segredo|secreto|secret|秘密|hidden|escondid|oculto/i,
  tutorial: /tutorial|how to|como |cómo|guia|guía|guide|dica|truco|tips|教程|攻略|passo a passo/i,
  curiosity: /curios|facts?\b|detal|details|冷知识|细节|did you know|você sabia|sabías/i,
};

function classify(title, fromQuery) {
  // O título manda mais que a busca (ex.: "easter egg" achado na busca de curiosidades).
  for (const cat of ["easter_egg", "tutorial", "curiosity"]) {
    if (KEYWORDS[cat].test(title)) return cat;
  }
  return fromQuery;
}

function seconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

async function yt(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY })) {
    url.searchParams.set(k, v);
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`YouTube ${endpoint} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function updateVideos() {
  if (!process.env.YOUTUBE_API_KEY) {
    console.log("YOUTUBE_API_KEY ausente: pulando vídeos.");
    return;
  }
  // Cada busca custa 100 unidades. Para caber na cota diária, cada execução
  // atualiza só alguns idiomas, em rodízio (config.maxSearchesPerRun).
  const stateFile = path.join(CACHE, "video_rotation.json");
  const state = readJson(stateFile, { next: 0 });
  const costOf = (l) => Object.values(config.queries[l]).flat().length;
  const turn = [];
  let budget = config.maxSearchesPerRun || 30;
  for (let i = 0; i < config.langs.length; i++) {
    const l = config.langs[(state.next + i) % config.langs.length];
    if (costOf(l) > budget) break;
    budget -= costOf(l);
    turn.push(l);
  }
  state.next = (state.next + turn.length) % config.langs.length;
  writeJson(stateFile, state);
  console.log(`vídeos: idiomas desta vez: ${turn.join(", ")}`);

  for (const lang of turn) {
    const file = path.join(OUT, `catalog_${lang}.json`);
    const old = readJson(file, { videos: [] });
    const byId = new Map(old.videos.map((v) => [v.id, v]));
    const found = new Map(); // id -> categoria vinda da busca

    for (const [cat, queries] of Object.entries(config.queries[lang])) {
      for (const q of queries) {
        const res = await yt("search", {
          part: "snippet",
          type: "video",
          q,
          maxResults: 25,
          order: "date",
          relevanceLanguage: config.youtubeLang[lang],
          safeSearch: "moderate",
          videoEmbeddable: "true",
        });
        for (const item of res.items || []) {
          const id = item.id?.videoId;
          if (id && !byId.has(id) && !found.has(id)) found.set(id, cat);
        }
      }
    }

    // Detalhes (duração, se pode ser incorporado) em lotes de 50: 1 unidade cada.
    const ids = [...found.keys()];
    let added = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const res = await yt("videos", {
        part: "snippet,contentDetails,status",
        id: ids.slice(i, i + 50).join(","),
      });
      for (const v of res.items || []) {
        const title = decodeEntities(v.snippet.title);
        if (!GTA6.test(title + " " + (v.snippet.tags || []).join(" "))) continue;
        if (!v.status?.embeddable) continue;
        if (seconds(v.contentDetails.duration) < config.minSeconds) continue;
        byId.set(v.id, {
          id: v.id,
          title,
          channel: v.snippet.channelTitle,
          publishedAt: v.snippet.publishedAt,
          thumb: v.snippet.thumbnails?.high?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          category: classify(title, found.get(v.id)),
          duration: v.contentDetails.duration,
        });
        added++;
      }
    }

    // Mantém os mais recentes de cada categoria.
    const all = [...byId.values()].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    const count = {};
    const videos = all.filter((v) => (count[v.category] = (count[v.category] || 0) + 1) <= config.maxPerCategory);
    writeJson(file, { updatedAt: new Date().toISOString(), lang, videos });
    console.log(`[${lang}] +${added} vídeos novos, total ${videos.length}`);
  }
}

// ---------------------------------------------------------------- WIKI

// Remove elementos inteiros (com tudo que tem dentro), respeitando aninhamento.
function removeElements(html, tag, classTest) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  let out = "";
  let pos = 0;
  let m;
  while ((m = open.exec(html))) {
    const cls = /class="([^"]*)"/i.exec(m[0])?.[1] || "";
    if (classTest && !classTest.test(cls)) continue;
    // Acha o fechamento correspondente contando aberturas/fechamentos.
    const any = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "gi");
    any.lastIndex = m.index + m[0].length;
    let depth = 1;
    let t;
    while (depth > 0 && (t = any.exec(html))) depth += t[0][1] === "/" ? -1 : 1;
    const end = t ? any.lastIndex : html.length;
    out += html.slice(pos, m.index);
    pos = end;
    open.lastIndex = end;
  }
  return out + html.slice(pos);
}

function cleanHtml(html) {
  let s = html;
  for (const tag of ["style", "script", "aside", "table", "figure", "sup", "ol"]) {
    s = removeElements(s, tag, tag === "ol" ? /references/ : null);
  }
  s = removeElements(s, "div", /tophat|wiki-quote-below|chronology|navigation|toc|gallery|references|wiki-ref|HideFandom/);
  s = removeElements(s, "span", /mw-editsection/);
  return s;
}

function htmlToText(html) {
  let s = html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n$1\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/\[edit[^\]]*\]/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Remove os avisos padrão de "conteúdo futuro" da wiki.
  return s
    .split("\n")
    .filter((l) => !/upcoming .* release|do not add unconfirmed|speculative content/i.test(l))
    .join("\n")
    .trim();
}

async function wikiApi(params) {
  const url = new URL(config.wiki.api);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", redirects: "1", ...params })) {
    url.searchParams.set(k, v);
  }
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`wiki: ${j.error.info}`);
  return j.parse;
}

async function fetchCharacterEnglish(ch) {
  const page = await wikiApi({ action: "parse", page: ch.page, prop: "text" });
  const html = cleanHtml(page.text);
  // Divide a página pelos títulos de nível 2 (h2). Subseções (h3) ficam dentro.
  const pieces = html.split(/(<h2[^>]*>[\s\S]*?<\/h2>)/i);
  const lead = htmlToText(pieces[0]);
  const top = [];
  for (let i = 1; i < pieces.length; i += 2) {
    top.push({ title: htmlToText(pieces[i]), body: htmlToText(pieces[i + 1] || "") });
  }
  const sections = {};
  for (const [key, names] of Object.entries(config.wiki.sectionMap)) {
    const parts = key === "story" && lead ? [lead] : [];
    for (const s of top) {
      if (!s.body || !names.some((n) => n.toLowerCase() === s.title.toLowerCase())) continue;
      parts.push(key === "story" ? s.body : `${s.title}\n${s.body}`);
    }
    const text = parts.join("\n\n").slice(0, config.wiki.maxSectionChars).trim();
    if (text) sections[key] = text;
  }
  return { name: page.title, sections, url: config.wiki.pageUrl + encodeURIComponent(page.title.replace(/ /g, "_")) };
}

const LANG_NAMES = {
  pt: "Brazilian Portuguese", es: "Latin American Spanish", fr: "French", it: "Italian",
  de: "German", ru: "Russian", pl: "Polish", tr: "Turkish", ar: "Arabic", hi: "Hindi",
  ja: "Japanese", ko: "Korean", zh: "Simplified Chinese", id: "Indonesian",
};

function roleName(role, lang) {
  const names = config.roleNames[role] || {};
  return names[lang] || names.en || role;
}

let anthropic = null;
async function translate(sections, lang) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  }
  const keys = Object.keys(sections);
  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
          required: keys,
          additionalProperties: false,
        },
      },
    },
    system:
      `Translate video game wiki text from English into ${LANG_NAMES[lang]}. ` +
      "Keep proper names (characters, places, the game title, mission names) as they are. " +
      "Keep line breaks and bullet points. Return each field translated under the same key.",
    messages: [{ role: "user", content: JSON.stringify(sections) }],
  });
  if (response.stop_reason === "refusal") return null;
  const text = response.content.find((b) => b.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function updateWiki() {
  const tcacheFile = path.join(CACHE, "translations.json");
  const tcache = readJson(tcacheFile, {});
  const results = Object.fromEntries(config.langs.map((l) => [l, []]));

  for (const ch of config.characters) {
    let en = null;
    try {
      en = await fetchCharacterEnglish(ch);
    } catch (e) {
      console.log(`wiki: ${ch.page} falhou (${e.message}), usando texto manual.`);
    }
    const man = manual[ch.id] || {};
    const enSections = { ...(man.en?.sections || {}), ...(en?.sections || {}) };

    for (const lang of config.langs) {
      let sections = enSections;
      if (lang !== "en" && Object.keys(enSections).length) {
        const key = `${ch.id}:${lang}:${sha(JSON.stringify(enSections))}`;
        if (!tcache[key]) {
          try {
            const t = await translate(enSections, lang);
            if (t) tcache[key] = t;
          } catch (e) {
            console.log(`tradução ${ch.id}/${lang} falhou: ${e.message}`);
          }
        }
        // Tradução automática > texto manual no idioma > inglês (último caso).
        sections = tcache[key] || man[lang]?.sections || enSections;
      }
      results[lang].push({
        id: ch.id,
        name: en?.name || man.en?.name || ch.page,
        role: roleName(ch.role, lang),
        age: ch.age?.[lang] || ch.age?.en || null,
        image: ch.image || null,
        color: ch.color,
        spoilers: ch.spoilers || [],
        sections,
        source: en ? { title: "GTA Wiki: " + en.name, url: en.url } : null,
      });
    }
    console.log(`wiki: ${ch.page} ok (${Object.keys(enSections).join(", ") || "vazio"})`);
  }

  writeJson(tcacheFile, tcache);
  for (const lang of config.langs) {
    const file = path.join(OUT, `wiki_${lang}.json`);
    const characters = results[lang].filter((c) => Object.keys(c.sections).length);
    const hash = sha(JSON.stringify(characters));
    const old = readJson(file, {});
    // updatedAt só muda quando o conteúdo muda (o app usa isso para notificar).
    const updatedAt = old.hash === hash ? old.updatedAt : new Date().toISOString();
    writeJson(file, {
      updatedAt,
      hash,
      lang,
      license: { text: config.wiki.licenseText, url: config.wiki.licenseUrl },
      characters,
    });
  }
}

// ---------------------------------------------------------------- MAIN

if (doVideos) await updateVideos();
if (doWiki) await updateWiki();
if (args.has("--assets")) {
  fs.mkdirSync(ASSETS, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.copyFileSync(path.join(OUT, f), path.join(ASSETS, f));
  console.log("Copiado para assets/data.");
}
console.log("Pronto.");
