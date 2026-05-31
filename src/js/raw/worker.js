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
    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let regex;
    try {
        if (/[\\":\-]/.test(kw)) {
            regex = new RegExp(escapeRegExp(kw), "gi");
        } else {
            const cleanKw = kw.replace(/\s+/g, ""); 
            const pattern = cleanKw.split("")
                                   .map(c => escapeRegExp(c))
                                   .join("\\s*");
            regex = new RegExp(pattern, "gi");
        }
    } catch (e) {
        return [];
    }

    let results = [];
    for (let i = 0; i < localData.length; i += 4) {
        let title = localData[i] || "";
        let rawContent = localData[i + 1] || "";
        let path = localData[i + 2] || "";
        let type = localData[i + 3] || "";
        
        let isLocalOnly = false;
        let searchableContent = rawContent;
        
        if (rawContent.startsWith("localOnly")) {
            isLocalOnly = true;
            searchableContent = rawContent.replace(/^localOnly/, "");
        }

        title = path.split("/").pop(); 

        let count = ((searchableContent.match(regex) || []).length) +
                    ((title.match(regex) || []).length);

        if (count === 0 && (type !== "html" && type !== "image")) {
            count = ((localData[i + 2].match(regex) || []).length);
        }

        if (count > 0) {
            results.push({ title, count, type, path, searchableContent, localOnly: isLocalOnly });
        }
    }
    return results.sort((a, b) => b.count - a.count);
}