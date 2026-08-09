const synonymGroups = [
    ["糊涂", "秀逗", "脑子进水"],
    ["简直", "一定"],
    ["源码", "代码", "脚本"],
];

const MAX_CANDIDATES_PER_GROUP = 3;
const MAX_VARIANTS = 6;
const MAX_MULTI_REPLACE_SPANS = 2;

function buildSynonymIndex(groups) {
    const wordToGroup = new Map();
    groups.forEach((group, gid) => {
        group.forEach(word => wordToGroup.set(word, gid));
    });
    const allWords = [...wordToGroup.keys()].sort((a, b) => b.length - a.length);
    return { wordToGroup, allWords, groups };
}

export const synonymIndex = buildSynonymIndex(synonymGroups);

function matchSynonymSpans(keyword, index) {
    const { allWords, wordToGroup } = index;
    const occupied = new Array(keyword.length).fill(false);
    const spans = []; 

    for (const word of allWords) { 
        let from = 0;
        let pos;
        while ((pos = keyword.indexOf(word, from)) !== -1) {
            const end = pos + word.length;
            const overlapped = occupied.slice(pos, end).some(Boolean);
            if (!overlapped) {
                spans.push({ start: pos, end, word, groupId: wordToGroup.get(word) });
                for (let i = pos; i < end; i++) occupied[i] = true;
            }
            from = pos + 1;
        }
    }
    spans.sort((a, b) => a.start - b.start);
    return spans;
}

function cartesianWithIdentity(arrays) {
    return arrays.reduce((acc, curr) => {
        const res = [];
        acc.forEach(a => {
            curr.concat([null]).forEach(c => res.push([...a, c]));
        });
        return res;
    }, [[]]);
}

export function expandQuery(keyword, index = synonymIndex) {
    const spans = matchSynonymSpans(keyword, index);
    if (spans.length === 0) return { variants: [], spans };

    const candidatesPerSpan = spans.map(s => {
        const group = index.groups[s.groupId].filter(w => w !== s.word);
        return group.slice(0, MAX_CANDIDATES_PER_GROUP);
    });

    const variants = new Set();

    spans.forEach((s, i) => {
        candidatesPerSpan[i].forEach(cand => {
            variants.add(keyword.slice(0, s.start) + cand + keyword.slice(s.end));
        });
    });

    if (spans.length > 1 && spans.length <= MAX_MULTI_REPLACE_SPANS) {
        const combos = cartesianWithIdentity(candidatesPerSpan);
        combos.forEach(combo => {
            if (combo.every(c => c === null)) return; 
            let v = "", cursor = 0;
            spans.forEach((s, i) => {
                v += keyword.slice(cursor, s.start) + (combo[i] ?? s.word);
                cursor = s.end;
            });
            v += keyword.slice(cursor);
            variants.add(v);
        });
    }

    variants.delete(keyword); 
    return { variants: [...variants].slice(0, MAX_VARIANTS), spans };
}