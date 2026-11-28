/**
 * synonyms.js —— 语料 DF 软加权 + 现代词覆盖近义扩展引擎 (v5.1，运行于 Worker 线程)
 * 由 swamp-server (builder::synonyms) 从 cilin.txt + synonyms_custom.json + 公开语料 DF 自动构建。
 */

const SYN_ALGO_VERSION = __SYN_ALGO_VERSION__;
const MAX_VARIANTS = 16;
const LRU_CAPACITY = 256;
const MIN_ABS_SCORE = 0.15;

// DF 分桶表（0 = 公网语料未出现，保留作入口并靠 Bloom 兜底本地私密页与动态评论）
const DF_CAND_MULT = [0.62, 1.00, 1.12, 1.18, 1.00, 0.68, 0.38];
const DF_SENSE_CONTRIB = [0.00, 0.25, 0.45, 0.60, 0.35, 0.10, 0.00];

const CUSTOM_SYNONYM_GROUPS = __CUSTOM_SYNONYM_GROUPS__;
const CUSTOM_ONEWAY_ALIASES = __CUSTOM_ONEWAY_ALIASES__;
const CILIN_RAW_DATA = `__CILIN_RAW_DATA__`;

const CJK_CHAR_RE = /[\u4e00-\u9fff]/;
const ASCII_ALNUM_RE = /[a-z0-9]/;

function toHalfwidth(str) {
    let out = "";
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code === 0x3000) {
            out += " ";
        } else if (code >= 0xFF01 && code <= 0xFF5E) {
            out += String.fromCharCode(code - 0xFEE0);
        } else {
            out += str.charAt(i);
        }
    }
    return out;
}

function compactKey(str) {
    return toHalfwidth(String(str || "")).replace(/\s+/g, "").toLowerCase();
}

// =========================================================================
// 1. 索引构建（流式扫行 + DF 分桶解析 + 单向别名 + FNV 指纹）
// =========================================================================
const eqGroups = [];
const wordToEq = new Map();
const wordToAlias = new Map();
const wordDf = new Map();
const lexicon = new Map();

let maxLexLen = 2;
let rawLineCount = 0;

let sigH1 = 0x811c9dc5;
let sigH2 = 0x1b873593;
function feedSig(str) {
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        sigH1 = Math.imul(sigH1 ^ c, 0x01000193);
        sigH2 = Math.imul(sigH2 ^ c, 0x85ebca6b) ^ (sigH2 >>> 15);
    }
}

function recordWordDf(key, bucket) {
    if (bucket <= 0) return;
    const prev = wordDf.get(key) || 0;
    if (bucket > prev) wordDf.set(key, bucket);
}

function parseWordAndDf(tok) {
    const len = tok.length;
    if (len >= 4 && tok.charCodeAt(len - 2) === 58) {
        const d = tok.charCodeAt(len - 1) - 48;
        if (d >= 1 && d <= 6) {
            return { word: tok.slice(0, len - 2), df: d };
        }
    }
    return { word: tok, df: 0 };
}

function addLexCode(word, code5, isEq) {
    const key = compactKey(word);
    if (key.length < 2) return;
    if (key.length > maxLexLen && key.length <= 12) maxLexLen = key.length;
    let entry = lexicon.get(key);
    if (!entry) {
        entry = { eq: !!isEq, codes5: [code5] };
        lexicon.set(key, entry);
    } else {
        if (isEq) entry.eq = true;
        if (entry.codes5.length < 8 && entry.codes5.indexOf(code5) === -1) {
            entry.codes5.push(code5);
        }
    }
}

function registerEqGroup(code7, c5, words, isCustom) {
    const gid = eqGroups.length;
    eqGroups.push({
        code: code7,
        c5,
        c1: c5.charAt(0),
        words,
        custom: !!isCustom
    });
    for (let pos = 0; pos < words.length; pos++) {
        const w = words[pos];
        const key = compactKey(w);
        let arr = wordToEq.get(key);
        if (!arr) {
            arr = [];
            wordToEq.set(key, arr);
        }
        arr.push({ gid, pos });
        addLexCode(w, c5, true);
    }
}

// 1.1 加载自定义双向同义词组（构建期已执行 exclusive 冲突剥离）
for (let i = 0; i < CUSTOM_SYNONYM_GROUPS.length; i++) {
    const entry = CUSTOM_SYNONYM_GROUPS[i];
    const grp = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.words) ? entry.words : null);
    const c5 = (!Array.isArray(entry) && entry && typeof entry.c5 === "string" && entry.c5.length >= 5)
        ? entry.c5.slice(0, 5)
        : "Zz00Z";
    if (!grp || grp.length < 2) continue;
    const cleaned = [];
    const seen = new Set();
    for (let j = 0; j < grp.length; j++) {
        const w = toHalfwidth(String(grp[j] || "")).trim();
        const k = compactKey(w);
        if (k.length < 2) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        cleaned.push(w);
    }
    if (cleaned.length >= 2) {
        feedSig(c5 + ":" + cleaned.join("|"));
        registerEqGroup("Zz" + String(i).padStart(5, "0"), c5, cleaned, true);
    }
}

// 1.2 加载自定义单向别名（src -> targets，反向不污染）
if (CUSTOM_ONEWAY_ALIASES && typeof CUSTOM_ONEWAY_ALIASES === "object") {
    const aliasKeys = Object.keys(CUSTOM_ONEWAY_ALIASES);
    for (let i = 0; i < aliasKeys.length; i++) {
        const rawSrc = toHalfwidth(String(aliasKeys[i] || "")).trim();
        const sk = compactKey(rawSrc);
        if (sk.length < 2) continue;
        const rawTargets = CUSTOM_ONEWAY_ALIASES[aliasKeys[i]];
        if (!Array.isArray(rawTargets) || rawTargets.length === 0) continue;
        const cleaned = [];
        const seen = new Set();
        for (let j = 0; j < rawTargets.length; j++) {
            const tw = toHalfwidth(String(rawTargets[j] || "")).trim();
            const tk = compactKey(tw);
            if (tk.length < 2) continue;
            if (tk === sk || seen.has(tk)) continue;
            seen.add(tk);
            cleaned.push(tw);
            addLexCode(tw, "Zz00A", false);
        }
        if (cleaned.length > 0) {
            feedSig("A:" + sk + ">" + cleaned.join("|"));
            wordToAlias.set(sk, cleaned);
            addLexCode(rawSrc, "Zz00A", true);
        }
    }
}

// 1.3 流式加载预清洗词林数据（含 :1..:6 分桶 DF）
const rawStr = CILIN_RAW_DATA || "";
const rawLen = rawStr.length;
feedSig(String(rawLen));

let lineStart = 0;
while (lineStart < rawLen) {
    let lineEnd = rawStr.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = rawLen;
    let end = lineEnd;
    if (end > lineStart && rawStr.charCodeAt(end - 1) === 13) end--;

    if (end > lineStart) {
        const line = rawStr.slice(lineStart, end);
        rawLineCount++;
        feedSig(line);

        const sep = line.indexOf("|");
        if (sep >= 8) {
            const code7 = line.slice(0, 7);
            const rel = line.charAt(7);
            const c5 = code7.slice(0, 5);
            const rawTokens = line.slice(sep + 1).split(" ");
            const words = [];
            for (let j = 0; j < rawTokens.length; j++) {
                const tok = rawTokens[j];
                if (!tok) continue;
                const parsed = parseWordAndDf(tok);
                if (parsed.word.length < 2) continue;
                if (parsed.df > 0) recordWordDf(parsed.word.toLowerCase(), parsed.df);
                words.push(parsed.word);
            }

            if (rel === "=" && words.length >= 2) {
                registerEqGroup(code7, c5, words, false);
            } else {
                for (let j = 0; j < words.length; j++) {
                    addLexCode(words[j], c5, false);
                }
            }
        }
    }
    lineStart = lineEnd + 1;
}

const DATA_SIG = SYN_ALGO_VERSION + ":" + (sigH1 >>> 0).toString(36) + (sigH2 >>> 0).toString(36);

// =========================================================================
// 2. 语义树距离、位置显著度、DF 软加权与语素加权辅助函数
// =========================================================================
function lcaLevel5(a, b) {
    if (a === b) return 5;
    if (a.charCodeAt(0) !== b.charCodeAt(0)) return 0;
    if (a.charCodeAt(1) !== b.charCodeAt(1)) return 1;
    if (a.charCodeAt(2) === b.charCodeAt(2) && a.charCodeAt(3) === b.charCodeAt(3)) return 4;
    return 2;
}

function queryPosSalience(pos, senseCount) {
    if (senseCount <= 1) return 1 / (1 + 0.02 * Math.min(pos, 15));
    return 1 / (1 + 0.07 * Math.min(pos, 15));
}

function candPosSalience(pos) {
    return 1 / (1 + 0.18 * Math.log(1 + pos));
}

function groupCohesion(len) {
    if (len <= 2) return 0.76;
    if (len === 3) return 0.84;
    if (len <= 12) return 1.0;
    return 1 / (1 + 0.10 * Math.log(len / 12));
}

function dfCandMult(key) {
    const b = wordDf.get(key) || 0;
    return DF_CAND_MULT[b] || DF_CAND_MULT[0];
}

function senseDfBoost(group, excludeKey) {
    let activity = 0;
    const ws = group.words;
    for (let i = 0; i < ws.length; i++) {
        const k = ws[i].toLowerCase();
        if (k === excludeKey) continue;
        const b = wordDf.get(k) || 0;
        if (b > 0) activity += DF_SENSE_CONTRIB[b];
    }
    return 1 + 0.32 * Math.log(1 + activity);
}

function sharedCjkRatio(a, b) {
    if (a.length < 2 || b.length < 2) return 0;
    let hit = 0;
    for (let i = 0; i < a.length; i++) {
        const ch = a[i];
        if (a.indexOf(ch) !== i) continue;
        if (CJK_CHAR_RE.test(ch) && b.indexOf(ch) !== -1) hit++;
    }
    return hit / Math.max(a.length, b.length);
}

function contextLcaBoost(c5, ctxCodes5) {
    if (!ctxCodes5 || ctxCodes5.length === 0) return 1.0;
    let best = 0;
    for (let i = 0; i < ctxCodes5.length; i++) {
        const lv = lcaLevel5(c5, ctxCodes5[i]);
        if (lv > best) best = lv;
        if (best === 5) break;
    }
    if (best >= 5) return 1.85;
    if (best >= 4) return 1.45;
    if (best >= 2) return 1.18;
    if (best >= 1) return 1.08;
    return 1.0;
}

// =========================================================================
// 3. 单词一跳扩展核心（DF 义项消歧 + DF 候选软加权 + 单向别名 + K/L 降权）
// =========================================================================
function expandSingleWord(rawWord, ctxCodes5, isWholeQuery, limit, existsInCorpus) {
    const key = compactKey(rawWord);
    const refs = wordToEq.get(key) || [];
    const aliasTargets = wordToAlias.get(key) || null;
    if (refs.length === 0 && (!aliasTargets || aliasTargets.length === 0)) return [];

    const srcSenseWeights = new Map();
    let hasDisambiguateBoost = false;
    const nonCustomRefs = [];
    for (let i = 0; i < refs.length; i++) {
        if (!eqGroups[refs[i].gid].custom) nonCustomRefs.push(refs[i]);
    }
    const ncCount = nonCustomRefs.length;

    for (let i = 0; i < refs.length; i++) {
        const { gid, pos } = refs[i];
        const g = eqGroups[gid];

        let wSense;
        if (g.custom) {
            wSense = 1.5;
        } else {
            wSense = queryPosSalience(pos, ncCount) * groupCohesion(g.words.length) * senseDfBoost(g, key);
            if (g.c1 === "K") wSense *= 0.22;
            else if (g.c1 === "L") wSense *= 0.55;
            if (ctxCodes5 && ctxCodes5.length > 0) {
                const boost = contextLcaBoost(g.c5, ctxCodes5);
                if (boost >= 1.18) hasDisambiguateBoost = true;
                wSense *= boost;
            }
        }
        srcSenseWeights.set(gid, wSense);
    }

    const wholePolysemy = isWholeQuery && ncCount >= 3;
    const compPolysemy = !isWholeQuery && ncCount >= 3 && !hasDisambiguateBoost;
    const effLimit = compPolysemy
        ? Math.min(limit, 4)
        : (wholePolysemy ? Math.min(limit, ncCount >= 4 ? 6 : 8) : limit);

    const allowedGids = new Set();
    if (wholePolysemy || compPolysemy) {
        for (let i = 0; i < ncCount; i++) {
            const { gid, pos } = nonCustomRefs[i];
            if (pos > 2) {
                srcSenseWeights.set(gid, srcSenseWeights.get(gid) * (wholePolysemy ? 0.55 : 0.48));
            }
        }
        const rankedNc = nonCustomRefs.slice().sort((a, b) =>
            (srcSenseWeights.get(b.gid) - srcSenseWeights.get(a.gid)) || (a.pos - b.pos)
        );
        const maxSenses = (compPolysemy || ncCount >= 4) ? 2 : 3;
        for (let i = 0; i < Math.min(maxSenses, rankedNc.length); i++) {
            allowedGids.add(rankedNc[i].gid);
        }
        for (let i = 0; i < refs.length; i++) {
            if (eqGroups[refs[i].gid].custom) allowedGids.add(refs[i].gid);
        }
    } else {
        for (let i = 0; i < refs.length; i++) allowedGids.add(refs[i].gid);
    }

    const cands = new Map();
    if (aliasTargets && aliasTargets.length > 0) {
        for (let j = 0; j < aliasTargets.length; j++) {
            const tw = aliasTargets[j];
            const tk = compactKey(tw);
            if (tk === key) continue;
            cands.set(tk, {
                word: tw,
                key: tk,
                score: 1.75 - j * 0.03,
                custom: true,
                alias: true,
                bestGid: -2,
                bestGidContrib: 1.75
            });
        }
    }

    for (let i = 0; i < refs.length; i++) {
        const { gid } = refs[i];
        if (!allowedGids.has(gid)) continue;
        const g = eqGroups[gid];
        const wSense = srcSenseWeights.get(gid);
        const ws = g.words;

        for (let j = 0; j < ws.length; j++) {
            const cw = ws[j];
            const ck = compactKey(cw);
            if (ck.length < 2) continue;
            if (ck === key) continue;

            let rec = cands.get(ck);
            if (!rec) {
                rec = {
                    word: cw,
                    key: ck,
                    score: 0,
                    custom: false,
                    alias: false,
                    bestGid: -1,
                    bestGidContrib: 0
                };
                cands.set(ck, rec);
            }
            if (g.custom) {
                rec.custom = true;
                rec.alias = false;
            }
            const contrib = wSense * (g.custom ? 1.2 : (candPosSalience(j) * dfCandMult(ck)));
            rec.score += contrib;
            if (contrib > rec.bestGidContrib) {
                rec.bestGidContrib = contrib;
                rec.bestGid = gid;
            }
        }
    }

    const scored = [];
    for (const rec of cands.values()) {
        if (rec.custom) {
            scored.push({
                word: rec.word,
                key: rec.key,
                score: rec.alias ? Math.min(1.85, rec.score) : Math.min(2.0, 1.5 + rec.score * 0.25),
                custom: true,
                alias: !!rec.alias,
                hop: 1,
                gid: rec.bestGid
            });
            continue;
        }

        let finalScore = rec.score * (1 + 0.12 * sharedCjkRatio(rawWord, rec.word));
        const lenDiff = Math.abs(rec.word.length - rawWord.length);
        if (rawWord.length <= 2 && rec.word.length >= 4) {
            finalScore *= 0.78;
        } else if (lenDiff >= 3) {
            finalScore *= 0.85;
        }

        if (finalScore < MIN_ABS_SCORE) continue;

        scored.push({
            word: rec.word,
            key: rec.key,
            score: finalScore,
            custom: false,
            alias: false,
            hop: 1,
            gid: rec.bestGid
        });
    }

    scored.sort((a, b) =>
        ((b.custom ? 1 : 0) - (a.custom ? 1 : 0)) ||
        (b.score - a.score) ||
        (a.word.length - b.word.length)
    );

    let topRegular = 0;
    for (let i = 0; i < scored.length; i++) {
        if (!scored[i].custom) {
            topRegular = scored[i].score;
            break;
        }
    }
    const minAccept = Math.max(MIN_ABS_SCORE, topRegular * 0.30);
    const maxPerGroup = allowedGids.size >= 2
        ? Math.max(3, Math.ceil(effLimit * ((wholePolysemy || compPolysemy) ? 0.5 : 0.6)))
        : effLimit;
    const groupCounts = new Map();
    const picked = [];
    const hasCorpusCheck = typeof existsInCorpus === "function";

    for (let i = 0; i < scored.length && picked.length < effLimit; i++) {
        const item = scored[i];
        if (!item.custom) {
            if (item.score < minAccept) continue;
            if (item.gid >= 0 && (groupCounts.get(item.gid) || 0) >= maxPerGroup) continue;
        }

        if (hasCorpusCheck && !existsInCorpus(item.word)) continue;

        if (isWholeQuery) {
            if (item.key.indexOf(key) !== -1) continue;
            let redundant = false;
            for (let p = 0; p < picked.length; p++) {
                const pv = picked[p];
                if (item.key.indexOf(pv.key) !== -1 && (!item.custom || pv.custom)) {
                    redundant = true;
                    break;
                }
            }
            if (redundant) continue;

            for (let p = picked.length - 1; p >= 0; p--) {
                const prev = picked[p];
                if (
                    prev.key.indexOf(item.key) !== -1 &&
                    (!prev.custom || item.custom) &&
                    item.score >= prev.score * 0.75
                ) {
                    picked.splice(p, 1);
                    if (prev.gid >= 0) {
                        groupCounts.set(prev.gid, Math.max(0, (groupCounts.get(prev.gid) || 1) - 1));
                    }
                }
            }
        }

        picked.push(item);
        if (item.gid >= 0) {
            groupCounts.set(item.gid, (groupCounts.get(item.gid) || 0) + 1);
        }
    }

    return picked;
}

// =========================================================================
// 4. 全词表 DP 最优分词（2+2 优于 3+1 + 空格硬边界 + 英文词边界保护）
// =========================================================================
function hasValidAsciiBoundary(lower, start, end) {
    if (ASCII_ALNUM_RE.test(lower.charAt(start)) && start > 0 && ASCII_ALNUM_RE.test(lower.charAt(start - 1))) {
        return false;
    }
    if (ASCII_ALNUM_RE.test(lower.charAt(end - 1)) && end < lower.length && ASCII_ALNUM_RE.test(lower.charAt(end))) {
        return false;
    }
    return true;
}

function segmentChunkDP(chunk, offset) {
    const lower = chunk.toLowerCase();
    const n = lower.length;
    const dp = new Float64Array(n + 1);
    const prev = new Int32Array(n + 1);
    const prevType = new Int8Array(n + 1);
    prev.fill(-1);

    for (let i = 0; i < n; i++) {
        if (dp[i] >= dp[i + 1]) {
            dp[i + 1] = dp[i];
            prev[i + 1] = i;
            prevType[i + 1] = 0;
        }
        const maxEnd = Math.min(n, i + maxLexLen);
        for (let j = i + 2; j <= maxEnd; j++) {
            if (!hasValidAsciiBoundary(lower, i, j)) continue;
            const sub = lower.slice(i, j);
            const lex = lexicon.get(sub);
            if (!lex) continue;
            const len = j - i;
            const gain = len * 2.0 + (len - 1) * 0.8 + (lex.eq ? 0.30 : 0.10);
            const cand = dp[i] + gain;
            if (cand > dp[j]) {
                dp[j] = cand;
                prev[j] = i;
                prevType[j] = lex.eq ? 2 : 1;
            }
        }
    }

    const spans = [];
    let cur = n;
    while (cur > 0) {
        const p = prev[cur];
        if (p < 0) break;
        if (prevType[cur] > 0) {
            const text = chunk.slice(p, cur);
            const lex = lexicon.get(text.toLowerCase());
            spans.push({
                start: offset + p,
                end: offset + cur,
                text,
                eq: prevType[cur] === 2,
                codes5: lex ? lex.codes5 : []
            });
        }
        cur = p;
    }
    spans.reverse();
    return spans;
}

function segmentQueryChunksDP(chunks) {
    const spans = [];
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const part = segmentChunkDP(chunk, offset);
        for (let j = 0; j < part.length; j++) spans.push(part[j]);
        offset += chunk.length;
    }
    return spans;
}

// =========================================================================
// 5. 顶层查询扩展入口（绝对置信度权重映射 + 语料 Bloom 非词校验）
// =========================================================================
const queryCache = new Map();

function clearSynonymCache() {
    queryCache.clear();
}

function toWeightedSpecs(detail) {
    const specs = [];
    for (let i = 0; i < detail.length; i++) {
        const it = detail[i];
        if (it.custom && !it.dual) {
            specs.push({ text: it.word, weight: it.alias ? 85 : 88, maxNoise: 0, tier: 1 });
            continue;
        }
        if (!it.custom && it.score < MIN_ABS_SCORE) continue;
        const absNorm = Math.min(1, Math.max(0, (it.score - MIN_ABS_SCORE) / (0.85 - MIN_ABS_SCORE)));
        if (it.dual) {
            specs.push({
                text: it.word,
                weight: Math.round(25 + 30 * absNorm),
                maxNoise: 0,
                tier: 2
            });
        } else {
            specs.push({
                text: it.word,
                weight: Math.round(35 + 45 * absNorm),
                maxNoise: 0,
                tier: 1
            });
        }
    }
    return specs;
}

function computeExpand(rawQuery, maxVariants, existsInCorpus) {
    const trimmed = toHalfwidth(String(rawQuery || "")).trim();
    if (!trimmed) return { variants: [], items: [], detail: [] };

    const chunks = trimmed.split(/\s+/).filter(Boolean);
    const clean = chunks.join("");
    if (clean.length < 2) return { variants: [], items: [], detail: [] };
    const cleanLower = clean.toLowerCase();

    // 情况 A：整串（含带空格的英文/多词短语）直接命中 '='、自定义词库或单向别名
    if (wordToEq.has(cleanLower) || wordToAlias.has(cleanLower)) {
        const items = expandSingleWord(clean, null, true, maxVariants, existsInCorpus);
        return {
            variants: items.map(x => x.word),
            items: toWeightedSpecs(items),
            detail: items
        };
    }

    // 情况 B：单块整词恰好是 '#' 或 '@' 独立词/专名（含 stopExpand 保护词），不拆开乱扩
    if (chunks.length === 1 && lexicon.has(cleanLower)) {
        return { variants: [], items: [], detail: [] };
    }

    // 情况 C：按空白分块执行 DP 最优切分 + 全句共享上下文消歧
    const spans = segmentQueryChunksDP(chunks);
    const expandable = spans.filter(s => s.eq);
    if (expandable.length === 0) return { variants: [], items: [], detail: [] };

    const perSpanCands = expandable.map(sp => {
        const ctxCodes = [];
        for (let i = 0; i < spans.length; i++) {
            if (spans[i] === sp) continue;
            const cs = spans[i].codes5;
            for (let j = 0; j < cs.length; j++) ctxCodes.push(cs[j]);
        }
        const perLimit = expandable.length === 1 ? maxVariants : Math.min(10, maxVariants);
        const items = expandSingleWord(sp.text, ctxCodes, false, perLimit, existsInCorpus);
        return { span: sp, items };
    }).filter(x => x.items.length > 0);

    if (perSpanCands.length === 0) return { variants: [], items: [], detail: [] };

    const hasCorpusCheck = typeof existsInCorpus === "function";
    const composed = [];

    // C.1 单槽替换
    for (let i = 0; i < perSpanCands.length; i++) {
        const { span, items } = perSpanCands[i];
        const prefix = clean.slice(0, span.start);
        const suffix = clean.slice(span.end);
        for (let j = 0; j < items.length; j++) {
            const it = items[j];
            const w = prefix + it.word + suffix;
            const k = compactKey(w);
            if (hasCorpusCheck) {
                if (!lexicon.has(k) && !existsInCorpus(w)) continue;
            } else if (!it.custom && it.score < 0.25 && !lexicon.has(k)) {
                continue;
            }
            composed.push({
                word: w,
                key: k,
                score: it.score * (1 + 0.06 * Math.min(span.text.length, 4)),
                custom: !!it.custom,
                alias: !!it.alias,
                hop: 1,
                dual: false,
                from: span.text + "→" + it.word
            });
        }
    }

    // C.2 双槽联合替换：仅保留词表词或语料 Bloom 命中的组合
    if (perSpanCands.length >= 2) {
        const ranked = perSpanCands
            .map((entry, idx) => ({
                entry,
                idx,
                priority:
                    entry.span.text.length * 0.5 +
                    Math.min(entry.items[0].score, 2.0) +
                    (entry.items[0].custom ? 0.6 : 0)
            }))
            .sort((x, y) => (y.priority - x.priority) || (y.idx - x.idx));

        let a = ranked[0].entry;
        let b = ranked[1].entry;
        if (a.span.start > b.span.start) {
            const tmp = a;
            a = b;
            b = tmp;
        }

        const topA = a.items.slice(0, 3);
        const topB = b.items.slice(0, 3);
        const p1 = clean.slice(0, a.span.start);
        const mid = clean.slice(a.span.end, b.span.start);
        const p3 = clean.slice(b.span.end);

        for (let i = 0; i < topA.length; i++) {
            for (let j = 0; j < topB.length; j++) {
                const w = p1 + topA[i].word + mid + topB[j].word + p3;
                const k = compactKey(w);
                if (!lexicon.has(k) && !(hasCorpusCheck && existsInCorpus(w))) continue;
                const sA = Math.min(topA[i].score, 1.0);
                const sB = Math.min(topB[j].score, 1.0);
                const dualScore = Math.min(sA, sB) * 0.80;
                if (dualScore < MIN_ABS_SCORE && !(topA[i].custom && topB[j].custom)) continue;
                composed.push({
                    word: w,
                    key: k,
                    score: dualScore,
                    custom: !!(topA[i].custom && topB[j].custom),
                    alias: false,
                    hop: 1,
                    dual: true,
                    from: a.span.text + "→" + topA[i].word + " & " + b.span.text + "→" + topB[j].word
                });
            }
        }
    }

    composed.sort((x, y) =>
        ((y.custom ? 1 : 0) - (x.custom ? 1 : 0)) ||
        ((x.dual ? 1 : 0) - (y.dual ? 1 : 0)) ||
        (y.score - x.score)
    );

    const picked = [];
    for (let i = 0; i < composed.length && picked.length < maxVariants; i++) {
        const c = composed[i];
        if (c.key === cleanLower || c.key.indexOf(cleanLower) !== -1) continue;

        let dup = false;
        for (let p = 0; p < picked.length; p++) {
            const pv = picked[p];
            if (c.key === pv.key) {
                dup = true;
                break;
            }
            if (c.key.indexOf(pv.key) !== -1 && (!c.custom || pv.custom) && (!pv.dual || c.dual)) {
                dup = true;
                break;
            }
        }
        if (dup) continue;

        for (let p = picked.length - 1; p >= 0; p--) {
            const prev = picked[p];
            if (
                prev.key.indexOf(c.key) !== -1 &&
                (!prev.custom || c.custom) &&
                (!c.dual || prev.dual) &&
                c.score >= prev.score * 0.75
            ) {
                picked.splice(p, 1);
            }
        }

        picked.push(c);
    }

    return {
        variants: picked.map(x => x.word),
        items: toWeightedSpecs(picked),
        detail: picked
    };
}

function expandQuery(query, options) {
    const limit = (options && typeof options.maxVariants === "number" && options.maxVariants > 0)
        ? Math.min(32, Math.floor(options.maxVariants))
        : MAX_VARIANTS;
    const existsInCorpus = options && typeof options.existsInCorpus === "function"
        ? options.existsInCorpus
        : null;
    const tag = (options && options.cacheTag ? String(options.cacheTag) : (existsInCorpus ? "b" : "0"));
    const norm = toHalfwidth(String(query || "")).trim().toLowerCase().replace(/\s+/g, " ");
    const cacheKey = limit + "|" + tag + "|" + norm;
    const hit = queryCache.get(cacheKey);
    if (hit) {
        queryCache.delete(cacheKey);
        queryCache.set(cacheKey, hit);
        return { variants: hit.variants.slice(), items: hit.items.slice() };
    }
    const res = computeExpand(query, limit, existsInCorpus);
    queryCache.set(cacheKey, res);
    if (queryCache.size > LRU_CAPACITY) {
        queryCache.delete(queryCache.keys().next().value);
    }
    return { variants: res.variants.slice(), items: res.items.slice() };
}

function debugExpandQuery(query, maxVariants = MAX_VARIANTS, options = null) {
    const existsInCorpus = options && typeof options.existsInCorpus === "function"
        ? options.existsInCorpus
        : null;
    return computeExpand(query, maxVariants, existsInCorpus);
}

const synonymIndex = {
    version: SYN_ALGO_VERSION,
    sig: DATA_SIG,
    maxVariants: MAX_VARIANTS,
    groups: [DATA_SIG],
    stats: {
        eqGroups: eqGroups.length,
        aliases: wordToAlias.size,
        dfWords: wordDf.size,
        lexiconSize: lexicon.size,
        rawLines: rawLineCount
    }
};

if (typeof globalThis !== "undefined") {
    globalThis.expandQuery = expandQuery;
    globalThis.debugExpandQuery = debugExpandQuery;
    globalThis.clearSynonymCache = clearSynonymCache;
    globalThis.synonymIndex = synonymIndex;
}

export { expandQuery, debugExpandQuery, clearSynonymCache, synonymIndex };

