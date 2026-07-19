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

function doSearch(kw) {
    if (!kw || localData.length === 0) return [];

    const escapeRegExp = (str) =>
        str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let regex;
    try {
        if (/[\\":\-]/.test(kw)) {
            regex = new RegExp(escapeRegExp(kw), "gi");
        } else {
            const cleanKw = kw.replace(/\s+/g, "");
            const pattern = cleanKw
                .split("")
                .map(c => escapeRegExp(c))
                .join("\\s*");
            regex = new RegExp(pattern, "gi");
        }
    } catch (e) {
        return [];
    }

    const HIT_CONTEXT = 20;
    const CLUSTER_GAP = 30;
    const MAX_CLUSTER_SPAN = 120;
    const MAX_SNIPPET_LENGTH = 200;

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

    let results = [];
    for (let i = 0; i < localData.length; i += 4) {
        let rawTitle = localData[i] || "";
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
            if (m.index === regex.lastIndex)
                regex.lastIndex++;
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

        results.push({
            title,
            count,
            type,
            path,
            localOnly: isLocalOnly,
            snippets
        });
    }

    return results.sort((a, b) => {
        if (b.count !== a.count)
            return b.count - a.count;

        return a.title.localeCompare(
            b.title,
            "zh-Hans-CN"
        );
    });
}