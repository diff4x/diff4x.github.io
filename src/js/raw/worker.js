let localData = [];

self.onmessage = function(e) {
    const { type, payload } = e.data;
    switch (type) {
        case 'SET_DATA':
            localData = payload;
            break;
        case 'SEARCH':
            const results = doSearch(payload.keyword);
            self.postMessage({ 
                type: 'SEARCH_RESULTS', 
                results, 
                keyword: payload.keyword,
                token: payload.token
            });
            break;
    }
};

// 正则表达式构建工厂
function buildRegex(kw, isTolerant = false) {
    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    try {
        if (/[\\":\-]/.test(kw)) {
            // 特殊符号进入精确严格匹配
            return new RegExp(escapeRegExp(kw), "gi");
        } else {
            const cleanKw = kw.replace(/\s+/g, "");
            const tokens = cleanKw.split("").map(c => escapeRegExp(c));
            
            // 核心改动：普通模式仅容忍空格，宽容模式容忍 0-3 个任意字符
            const gap = isTolerant ? "\\s*(?:[\\s\\S]{0,3}?)\\s*" : "\\s*";
            const pattern = tokens.join(gap);
            
            return new RegExp(pattern, "gi");
        }
    } catch (e) {
        return new RegExp("^$"); // 异常降级兜底
    }
}

// 调度引擎
function doSearch(kw) {
    if (!kw || localData.length === 0) return [];

    // 第一遍：精准模式
    let regex = buildRegex(kw, false);
    let results = executeSearchLoop(regex);

    // 第二遍：无结果时触发静默降级（宽容模式）
    if (results.length === 0) {
        regex = buildRegex(kw, true);
        results = executeSearchLoop(regex);
        
        // 可选：给宽容匹配到的结果打上标记，供给前台 index.js 做 UI 标识
        if (results.length > 0) {
            results.forEach(r => r.isTolerantMatch = true);
        }
    }

    return results.sort((a, b) => {
        // 第一优先级：综合得分 (Score)
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        
        // 第二优先级：真实匹配数量 (Count)
        if (b.count !== a.count) {
            return b.count - a.count;
        }

        // 第三优先级：标题字典序拼音排序
        return a.title.localeCompare(
            b.title,
            "zh-Hans-CN"
        );
    });
}

// 搜索执行单元与 Snippet 提取
function executeSearchLoop(regex) {
    const HIT_CONTEXT = 20;
    const CLUSTER_GAP = 30;
    const MAX_CLUSTER_SPAN = 120;
    const MAX_SNIPPET_LENGTH = 200;
    
    const WEIGHT_TITLE = 50;         // 标题命中 1 次，相当于内容命中 50 次
    const WEIGHT_CONTENT = 1;        // 内容基础得分
    const WEIGHT_CLUSTER_BONUS = 15; // 聚集度奖励：每多一个词与前一个词在 CLUSTER_GAP 范围内，额外加 15 分

    const PUNCT = /[，。！？；：,.!?;:\n]/;

    function adjustSnippetBoundary(text, start, end) {
        let s = start;
        let min = Math.max(0, start - 40); // 向前找最近标点（最多40字符）

        while (s > min) {
            if (PUNCT.test(text[s - 1])) break;
            s--;
        }

        let e = end;
        let max = Math.min(text.length, end + 40); // 向后找最近标点（最多40字符）
        while (e < max) {
            if (PUNCT.test(text[e])) {
                e++;
                break;
            }
            e++;
        }

        return {
            start: s,
            end: e
        };
    }

    function limitSnippetLength(text, start, end) {
        if (end - start <= MAX_SNIPPET_LENGTH) {
            return {
                start,
                end
            };
        }

        let maxEnd = start + MAX_SNIPPET_LENGTH;
        let cut = maxEnd; // 优先向后寻找标点

        const SEARCH_RANGE = 40;
        let limit = Math.min(
            text.length,
            maxEnd + SEARCH_RANGE
        );

        while (cut < limit) {
            if (PUNCT.test(text[cut])) {
                cut++;
                return {
                    start,
                    end: cut
                };
            }
            cut++;
        }
        
        cut = maxEnd; // 后面找不到标点，再向前找
        limit = Math.max(
            start,
            maxEnd - SEARCH_RANGE
        );

        while (cut > limit) {
            if (PUNCT.test(text[cut])) {
                return {
                    start,
                    end: cut + 1
                };
            }
            cut--;
        }

        return { // 最后硬截断
            start,
            end: maxEnd
        };
    }

    let loopResults = [];
    for (let i = 0; i < localData.length; i += 4) {
        // let rawTitle = localData[i] || ""; // 未使用变量省略以提升性能
        let rawContent = localData[i + 1] || "";
        let path = localData[i + 2] || "";
        let type = localData[i + 3] || "";

        let isLocalOnly = false;
        let searchableContent = rawContent;

        if (rawContent.startsWith("localOnly")) {
            isLocalOnly = true;
            searchableContent = rawContent.replace(/^localOnly/, "");
        }

        let title = path.split("/").pop();

        regex.lastIndex = 0; // 为了保证 match() 从头开始
        const titleHits = (title.match(regex) || []).length;

        regex.lastIndex = 0; // exec() 在带 g 时，会修改 lastIndex
        let hits = [];
        let m;
        while ((m = regex.exec(searchableContent)) !== null) {
            // 防止零宽匹配或正则空跑死循环拦截
            if (m.index === regex.lastIndex && m[0].length === 0) {
                regex.lastIndex++;
                continue;
            }
            hits.push({
                start: m.index,
                end: m.index + m[0].length
            });
        }

        const contentHits = hits.length;
        let count = titleHits + contentHits;
        if (
            count === 0 &&
            type !== "html" &&
            type !== "image"
        ) {
            regex.lastIndex = 0;
            count = (path.match(regex) || []).length;
        }
        if (count === 0)
            continue;

        let clusters = [];
        for (const hit of hits) {
            let last = clusters[clusters.length - 1];
            if (
                !last ||
                hit.start - last.last > CLUSTER_GAP ||
                hit.start - last.first > MAX_CLUSTER_SPAN
            ) {
                clusters.push({
                    first: hit.start,
                    last: hit.end,
                    hits: [hit]
                });
            } else {
                last.last = hit.end;
                last.hits.push(hit);
            }
        }

        let densityBonus = 0;
        for (const cluster of clusters) {
            // 如果一个聚簇里包含超过 1 个匹配项，说明关键词非常密集
            if (cluster.hits.length > 1) {
                // 每多聚集一个词，给予一次奖励分
                densityBonus += (cluster.hits.length - 1) * WEIGHT_CLUSTER_BONUS;
            }
        }
        
        // 综合得分 = (标题命中数 * 标题权重) + (内容命中数 * 内容基础权重) + 聚集度额外奖励
        let score = (titleHits * WEIGHT_TITLE) + (contentHits * WEIGHT_CONTENT) + densityBonus;
        // 如果是在无匹配情况下的 path 兜底命中，给予基础分
        if (titleHits === 0 && contentHits === 0 && count > 0) {
            score = count * WEIGHT_CONTENT; 
        }

        let snippets = [];
        for (const cluster of clusters) {
            let start = Math.max(
                0,
                cluster.first - HIT_CONTEXT
            );

            let end = Math.min(
                searchableContent.length,
                cluster.last + HIT_CONTEXT
            );

            ({ start, end } = adjustSnippetBoundary(
                searchableContent,
                start,
                end
            ));

            ({ start, end } = limitSnippetLength(
                searchableContent,
                start,
                end
            ));

            snippets.push(
                (start > 0 ? "..." : "") +
                searchableContent.substring(start, end) +
                (end < searchableContent.length ? "..." : "")
            );
        }

        loopResults.push({
            title,
            count,
            score,       // 新增：暗箱排序得分
            type,
            path,
            localOnly: isLocalOnly,
            snippets
        });
    }

    return loopResults;
}