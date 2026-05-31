/* ================================== txn_parser.js,  design by diff4x ================================== */

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload(); 
    });
}

// ==================================
// LS 代理与记忆库 (升级版：基于文件名自动分发默认值)
// ==================================
function createStore() {
    return new Proxy({}, {
        get(_, prop) {
            const val = localStorage.getItem(prop);
            if (val === null) {
                // 如果没有历史记录，根据属性后缀自动返回结构化的默认初始状态
                if (prop.endsWith('_trend')) return { endYear: null, endMonth: null, activeCat: 'net' };
                if (prop.endsWith('_view')) return { type: 'default', y: null, m: null };
                if (prop.endsWith('_filter')) return null;
                if (prop.endsWith('_page')) return {};
                if (prop.endsWith('_scroll')) return 0;
                return undefined;
            }
            try { return JSON.parse(val); } catch { return val; }
        },
        set(_, prop, value) {
            localStorage.setItem(prop, JSON.stringify(value));
            return true;
        },
        deleteProperty(_, prop) {
            localStorage.removeItem(prop);
            return true;
        }
    });
}
const store = createStore();

// 核心文件名记忆钩子
let currentFilename = 'txn.txt'; 
function getFileKey(suffix) {
    return `txn_${currentFilename}_${suffix}`;
}

// 节流保存当前账本的滚动位置
let scrollTid;
window.addEventListener('scroll', () => {
    clearTimeout(scrollTid);
    scrollTid = setTimeout(() => {
        store[getFileKey('scroll')] = window.scrollY;
    }, 100);
});


/*---------------
  映射
---------------*/
const ACCOUNTS = {
    a: '现金(♂️)',
    b: '储蓄(♂️)',
    c: '信用(♂️)',
    
    n: '现金(♀️)',
    o: '储蓄(♀️)',
    p: '信用(♀️)'
};

const DST_MAP = {   // 流向
    i: '收入',
    e: '支出',
    ...ACCOUNTS
};

const CAT_MAP = {   // 流向支出必须带上支出类别代码
    s: '食物',
    z: '住所',
    w: '网络',
    j: '交通',
    y: '医疗',
    r: '日化',
    f: '服饰',
    q: '其它'
};

const HE_ACCTS = ['a', 'b', 'c'];
const SHE_ACCTS = ['n', 'o', 'p'];

const CAT_MAP_EXT = { ...CAT_MAP, income: '报酬', transfer: '中转' };
const SRC_MAP = { ...ACCOUNTS };
const ACCOUNT_KEYS = Object.keys(ACCOUNTS);

// 解析与状态隔离变量
let flows = [];
let stats = null;
let hasParseError = false; 

// 过滤
const filterState = {
  y: new Set(),
  m: new Set(),
  d: new Set(),
  src: new Set(),
  dst: new Set(),
  cat: new Set(),
  amtMin: null,
  amtMax: null,
  noteRegex: null
};
const MAP_LOOKUP = {
  y: null,
  m: null,
  d: null,
  src: SRC_MAP,
  dst: DST_MAP,
  cat: CAT_MAP_EXT
};

// 趋势
let trendState = {
  endYear: null,
  endMonth: null,
  activeCat: null
};

// 十字准星与折点吸附
let hoverX = null;
let hoverY = null;
let hoverActive = false;

// 汇率
const FX_PRESET = {
  CNY: 1,
  USD: 0.14,
  EUR: 0.13,
  JPY: 15.6
};
const FX_KEY = 'fx_rates';
let FX = { ...FX_PRESET };
let fxMeta = { source: 'preset', approx: true };
let fxLoaded = false;
const cached = JSON.parse(localStorage.getItem(FX_KEY));
if (cached?.rates) {
  FX = cached.rates;
  fxMeta = { source: 'ls', approx: true };
  console.log('[FX] init from ls');
}

// 分页
const PAGE_SIZE = 50;
let currentFiltered = [];
let pagedContext = {
  data: [],
  page: 1,
  totals: null,
  container: null,
  id: null
};
const EDGE_PAGES = 1;   // 左右边缘固定显示的页数
const WINDOW = 7;      // 当前页附近连续显示多少页

// 色彩
const COLORS = {
  expense: '#c0392b',   // 支出 / 负数 / 左轴
  income: '#0a8f3c',   // 收入 / 正数 / 净变化
  transfer: '#2980b9',   // 中转
  axis: '#666',
  axisIdle: '#999',
  grid: '#ddd',
  inactive: '#bbb', // 折线
  text: '#333' // 文本
};
const CAT_COLORS = {
  s: COLORS.expense,
  z: COLORS.expense,
  w: COLORS.expense,
  j: COLORS.expense,
  y: COLORS.expense,
  r: COLORS.expense,
  f: COLORS.expense,
  q: COLORS.expense
};

// 样式表
const css = `
html,body { background:#cae4ff }
.hide { display:none; }
#fileInput { padding: 20px 0 0 40px; }
input[type="file"] { color: transparent }
#output { background:#cae4ff; padding:10px 10px 100vh 40px; font-size:0.8rem; }
.sep { margin:10px 0; padding-top:5px; border-top:1px solid #000; }
.error { color:red; }
#output button, .filter-btn { margin:2px; padding:2px 6px; cursor:pointer; }
#output table { border-collapse:collapse; margin-top:5px; }
#output th, #output td { border:1px solid #aaa; padding:2px 4px; text-align:left; }
#output tr:hover td { background-color:#eef4ff; }
#output td:nth-last-child(1), #output td:nth-last-child(3) { text-align:right; font-variant-numeric:tabular-nums; }
.filter-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.filter-item { display:flex; align-items:center; gap:4px; position:relative; }
.filter-title { white-space:nowrap; }
.filter-panel { position:absolute; top:100%; left:2rem; z-index:10; display:none; max-height:200px; overflow:auto; padding:4px; border:1px solid #aaa; background:#fff; white-space:nowrap; }
.filter-item.open .filter-panel { display:block; }
.amount { margin:0 2px; padding:1px; background-color:#fff; }
.amount.positive, .amount.income { color:${COLORS.income}; }
.amount.negative, .amount.expense { color:${COLORS.expense}; }
.amount.transfer { color:${COLORS.transfer}; }
.has-tip { position:relative; }
.has-tip .tip { display:none; position:absolute; left:0; bottom:120%; z-index:20; padding:6px 8px; border-radius:4px; font-size:12px; color:#fff; background:#333; white-space:nowrap; }
.has-tip:hover .tip { display:block; }
.tip-row { display:grid; grid-template-columns:auto 1fr; gap:8px; }
.tip-cur { opacity:0.8; }
.tip-val { min-width:90px; text-align:right; }
`;

const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.id = "fileInput";
fileInput.accept = ".txt";
fileInput.style = "width: 150px;"

// 创建并挂载纯静态示例下载链接
const a = document.createElement("a");
a.href = "data:text/plain;charset=utf-8,%23 ------------------- sample_txn.txt ---------------------%0A%0Aoef-100 外套颜色不对,退款                    %23 如果记成 %22oi100%22 会导致 %22总支%22 和 %22总收%22 双双虚高，财报失真%0Aoef100 外套                                 %23 从储蓄(♀️) 支出100到 服装%0Acew1000 订阅PlayBoy                         %23 从信用(♂️) 支出1000到 网络%0Abp800 替♀️还帐                              %23 从储蓄(♂️) 中转800到 信用(♀️) %0Aci1000 为中情局提供现索得到的赏金             %23 信用(♂️) 收入1000%0A%0A%23 ---------------------------------->  ❤️ 财务高度共享, 谁付钱不重要，重要的是家庭总资产%0Aoew50 给♂️充话费                            %23 从储蓄(♀️) 支出50到 网络%0A%0A%23 ---------------------------------->  🤣 严格AA, ♀️ 给 ♂️ 垫付话费并保留债权%0Abew50 用向♀️借来的钱充话费                   %23 从储蓄(♂️) 支出50到 网络%0Aob50 借给♂️                                 %23 从储蓄(♀️) 中转50到 储蓄(♂️)%0A%0Aab100                                       %23 从现金(♂️) 中转100到 储蓄(♂️)%0Aba300                                       %23 从储蓄(♂️) 中转300到 现金(♂️)%0A1%0A2026%0A%0Aaej20d03 加油                               %23 当月03号 从现金(♂️) 流向 支出20到 交通%0Aob100 转帐给♂️                              %23 从储蓄(♀️)  中转100到 储蓄(♂️)%0Aci-200 初始本金                              %23 ♂️的当前信用账单 (负债登记)%0A12%0Aai500 初始本金                               %23 ♂️的当前现金%0Abi1000 初始本金                              %23 ♂️的当前储蓄%0Api800 初始本金                               %23 ♀️的当前信用溢缴%0Aoi2000 初始本金                              %23 ♀️的当前储蓄%0A11%0A2025";
a.download = "sample_txn.txt";
a.innerText = "📥 下载 sample_txn.txt";
a.style.cssText = "margin-left: 20px; font-size: 0.9rem; text-decoration: none; color: #2980b9;";

const out = document.createElement("div");
out.className = "hide";
out.id = "output";
document.body.append(fileInput, a, out);

/*---------------
  监听
---------------*/
// 文件选择 (线上用户切换文件入口)
document.getElementById('fileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  // 核心：捕捉文件名，实现状态快照隔离切换
  currentFilename = file.name;

  const reader = new FileReader();
  reader.onload = () => {
    loadFX();
    parse(reader.result);
    e.target.value = '';
  };

  reader.readAsText(file, 'utf-8');
  out.classList.remove("hide");
});
// 焦点
document.addEventListener('focusin', e => {
  if (e.target.id === 'fa_min' || e.target.id === 'fa_max' || e.target.id === 'fnote') {
    e.target.select();
  }
});
// 点击
document.addEventListener('click', e => {
  if (e.target.id === 'freset') {
    resetFilterState();
    updateFilterOptions();
    ['y', 'm', 'd', 'src', 'dst', 'cat'].forEach(updateFilterButton);
    const rs = document.getElementById('rs');
    if (rs) rs.remove();
    return;
  }

  if (e.target.id === 'fgo') {
    renderFilteredFlows();
  }

  const btn = e.target.closest('.filter-btn');
  if (btn) {
    const item = btn.closest('.filter-item');
    document.querySelectorAll('.filter-item.open')
      .forEach(i => {
        if (i !== item) i.classList.remove('open');
      });
    item.classList.toggle('open');
    return;
  }

  if (e.target.closest('.filter-panel')) {
    return;
  }

  document.querySelectorAll('.filter-item.open')
    .forEach(i => i.classList.remove('open'));
});

/*---------------
  文件解析
---------------*/
function parse(text) {
  hasParseError = false; // 每次解析前复位

  const rawLines = text.split(/\r?\n/).map((l, i) => ({ line: l, lineNum: i + 1 }));
  const revLines = rawLines.slice().reverse();

  const errors = [];
  flows = [];

  let curYear = null, curMonth = null;
  const seenYears = new Set();
  const seenMonths = {};

  for (let idx = 0; idx < revLines.length; idx++) {
    const { line, lineNum } = revLines[idx];
    const l = line.trim();
    if (l === '' || l.startsWith('#')) continue;

    if (/^\d{4}$/.test(l)) {
      const y = Number(l);
      if (seenYears.has(y)) { errors.push({ lineNum, msg: `年份${y}重复` }); break; }
      curYear = y; curMonth = null;
      seenYears.add(y);
      seenMonths[curYear] = new Set();
      continue;
    }

    if (/^\d{1,2}$/.test(l)) {
      if (!curYear) { errors.push({ lineNum, msg: '月份行无归属年份' }); break; }
      const m = Number(l);
      if (m < 1 || m > 12) { errors.push({ lineNum, msg: `非法月份 ${m}` }); break; }
      if (seenMonths[curYear].has(m)) { errors.push({ lineNum, msg: `年份${curYear}重复月份${m}` }); break; }
      curMonth = m;
      seenMonths[curYear].add(m);
      continue;
    }

    if (!curYear) { errors.push({ lineNum, msg: '流水无归属年份' }); continue; }
    if (!curMonth) { errors.push({ lineNum, msg: '流水无归属月份' }); continue; }

    const ACC = ACCOUNT_KEYS.join('');
    const REG = new RegExp(
      `^([${ACC}])([ie${ACC}])([szjwyrfq]?)(-?\\d+(?:\\.\\d+)?)(d(0?[1-9]|[12]\\d|3[01]))?(?:\\s+(.+))?$`
    );
    const m = l.match(REG);
    if (!m) { errors.push({ lineNum, msg: '流水格式错误' }); continue; }

    const [, src, dst, cat, amt, dayStr, dayNum, note] = m;
    const amount = Number(amt);
    if (amount === 0) errors.push({ lineNum, msg: '金额不能为0' });
    if (dst === 'e' && !cat) errors.push({ lineNum, msg: '支出缺少分类' });
    if (dst !== 'e' && cat) errors.push({ lineNum, msg: '非支出不应有分类' });

    flows.push({
      year: curYear,
      month: curMonth,
      src, dst,
      cat: dst === 'e' ? cat || null : null,
      amount,
      day: dayNum ? Number(dayNum) : undefined,
      note,
      lineNum
    });
  }

  if (errors.length) { 
    hasParseError = true; // 拦截激活：存在严重语法错误
    renderErrors(errors); 
    return; 
  }

  computeStats();
  restoreState();
}

// 恢复总控函数
function restoreState() {
  if (hasParseError) return; // 🛡️ 语法报错拦截

  const view = store[getFileKey('view')];
  if (view.type === 'year') {
    renderYear(view.y);
  } else if (view.type === 'month') {
    renderMonth(view.y, view.m);
  } else {
    renderDefaultView(); 
  }
  
  // 恢复属于该文件的滚动位置
  setTimeout(() => {
    window.scrollTo(0, store[getFileKey('scroll')] || 0);
  }, 50);
}

/*---------------
  错误报告
---------------*/
function renderErrors(errors) {
  out.innerHTML = '<h4 class="error">原始记录错误报告</h4>';
  errors.sort((a, b) => a.lineNum - b.lineNum).forEach(e => {
    out.innerHTML += `<div class="error"><span class="error-line-link" data-line="${e.lineNum}">第 ${e.lineNum} 行</span>：${e.msg}</div>`;
  });
}

/*---------------
  统计
---------------*/
function computeStats() {
  stats = {
    accounts: {},
    years: {}
  };

  ACCOUNT_KEYS.forEach(k => {
    stats.accounts[k] = 0;
  });

  flows.forEach(f => {
    if (!stats.years[f.year]) stats.years[f.year] = { income: 0, expense: 0, cats: {}, months: {} };
    const y = stats.years[f.year];
    if (f.dst === 'i') { y.income += f.amount; stats.accounts[f.src] += f.amount; }
    else if (f.dst === 'e') { y.expense += f.amount; y.cats[f.cat] = (y.cats[f.cat] || 0) + f.amount; stats.accounts[f.src] -= f.amount; }
    else { stats.accounts[f.src] -= f.amount; stats.accounts[f.dst] += f.amount; }

    if (!y.months[f.month]) {
      y.months[f.month] = [];
    }
    y.months[f.month].push(f);

  });
}

function calcNetDebt(flowList) {
  let heToShe = 0;
  let sheToHe = 0;
  
  flowList.forEach(f => {
    if (HE_ACCTS.includes(f.src) && SHE_ACCTS.includes(f.dst)) heToShe += f.amount;
    if (SHE_ACCTS.includes(f.src) && HE_ACCTS.includes(f.dst)) sheToHe += f.amount;
  });
  
  // 逻辑：她给我花的钱 - 我给她花的钱。
  // 如果为正数，说明 ♂️ 欠 ♀️ 钱；如果为负数，说明 ♀️ 欠 ♂️ 钱。
  const netOwe = sheToHe - heToShe; 
  return { heToShe, sheToHe, netOwe };
}

/*---------------
  筛选状态记忆
---------------*/
function saveFilterState(isActive) {
  store[getFileKey('filter')] = {
    y: [...filterState.y],
    m: [...filterState.m],
    d: [...filterState.d],
    src: [...filterState.src],
    dst: [...filterState.dst],
    cat: [...filterState.cat],
    amtMin: document.getElementById('fa_min')?.value,
    amtMax: document.getElementById('fa_max')?.value,
    noteStr: document.getElementById('fnote')?.value || '',
    active: isActive
  };
}

function loadFilterState() {
  const f = store[getFileKey('filter')];
  if (!f) return;
  filterState.y = new Set(f.y || []);
  filterState.m = new Set(f.m || []);
  filterState.d = new Set(f.d || []);
  filterState.src = new Set(f.src || []);
  filterState.dst = new Set(f.dst || []);
  filterState.cat = new Set(f.cat || []);
  
  if (document.getElementById('fnote')) document.getElementById('fnote').value = f.noteStr || '';
  if (document.getElementById('fa_min') && f.amtMin != null) document.getElementById('fa_min').value = f.amtMin;
  if (document.getElementById('fa_max') && f.amtMax != null) document.getElementById('fa_max').value = f.amtMax;
}

function resetFilterState() {
  Object.keys(filterState).forEach(k => {
    if (filterState[k] instanceof Set) filterState[k].clear();
    else filterState[k] = null;
  });
  const fn = document.getElementById('fnote');
  if (fn) fn.value = '';
  const min = document.getElementById('fa_min');
  const max = document.getElementById('fa_max');
  if (min) min.value = -100000;
  if (max) max.value = 100000;
  
  saveFilterState(false);
  let pages = store[getFileKey('page')] || {};
  pages.filter = 1;
  store[getFileKey('page')] = pages;
}

/*---------------
  筛选
---------------*/
function renderFilteredFlows() {
  // 正则合法性
  const noteVal = document.getElementById('fnote')?.value?.trim();
  filterState.noteRegex = null;
  if (noteVal) {
    try {
      filterState.noteRegex = new RegExp(noteVal, 'i');
    } catch (e) {
      alert('非法正则');
      return;
    }
  }

  // 区间值处理
  const minVal = document.getElementById('fa_min')?.value;
  const maxVal = document.getElementById('fa_max')?.value;
  filterState.amtMin = minVal !== '' ? Number(minVal) : null;
  filterState.amtMax = maxVal !== '' ? Number(maxVal) : null;
  if (
    filterState.amtMin != null &&
    filterState.amtMax != null &&
    filterState.amtMin > filterState.amtMax
  ) {
    [filterState.amtMin, filterState.amtMax] =
      [filterState.amtMax, filterState.amtMin];
  }

  // 过滤逻辑
  currentFiltered = flows.filter(f => {
    if (filterState.y.size && !filterState.y.has(String(f.year))) return false;
    if (filterState.m.size && !filterState.m.has(String(f.month))) return false;
    if (filterState.d.size) {
      if (f.day == null) return false;
      if (!filterState.d.has(String(f.day))) return false;
    }
    if (filterState.src.size && !filterState.src.has(f.src)) return false;
    if (filterState.dst.size && !filterState.dst.has(f.dst)) return false;
    if (filterState.cat.size && !filterState.cat.has(getDisplayCat(f))) return false;
    if (filterState.amtMin != null && f.amount < filterState.amtMin) return false;
    if (filterState.amtMax != null && f.amount > filterState.amtMax) return false;
    if (filterState.noteRegex) {
      const note = f.note ?? '';
      if (!filterState.noteRegex.test(note)) return false;
    }
    return true;
  }).reverse();

  // 统计
  let totalIncome = 0;
  let totalExpense = 0;
  let totalTransfer = 0;
  currentFiltered.forEach(f => {
    if (f.dst === 'i') totalIncome += f.amount;
    else if (f.dst === 'e') totalExpense += f.amount;
    else {
      totalTransfer += f.amount;
    }
  });

  // 交付渲染
  let rs = document.getElementById('rs');
  if (!rs) {
    rs = document.createElement('div');
    rs.id = 'rs';
    out.appendChild(rs);
  }
  pagedContext = {
    data: currentFiltered,
    page: store[getFileKey('page')].filter || 1, // 各自独立的筛选页码
    totals: {
      totalIncome,
      totalExpense,
      totalTransfer
    },
    container: rs,
    id: 'filter' 
  };
  saveFilterState(true); 
  renderPagedContext();
}
function updateFilterButton(key) {
  const item = document.querySelector(`.filter-item[data-key="${key}"]`);
  if (!item) return;

  const btn = item.querySelector('.filter-btn');
  const vals = [...filterState[key]];
  const map = MAP_LOOKUP[key];

  if (vals.length === 0) {
    btn.textContent = ' ?  ▾';
    return;
  }

  const labels = vals.map(v => map?.[v] || v);

  btn.textContent =
    labels.length <= 2
      ? `${labels.join(', ')} ▾`
      : `${labels[0]} +${labels.length - 1} ▾`;
}
function onMultiFilterChange(key, el) {
  if (el.checked) {
    filterState[key].add(el.value);
  } else {
    filterState[key].delete(el.value);
  }
  updateFilterButton(key);
  if (filterState[key].size === 0) {
    document
      .querySelector(`.filter-item[data-key="${key}"]`)
      .classList.remove('open');
  }
  saveFilterState(store[getFileKey('filter')]?.active || false);
}

function updateFilterOptions() {
  document.querySelectorAll('.filter-item').forEach(item => {
    const key = item.dataset.key;
    const panel = item.querySelector('.filter-panel');
    if (key === 'y') buildCheckboxGroup('y', panel, f => f.year);
    if (key === 'm') buildCheckboxGroup('m', panel, f => f.month);
    if (key === 'd') buildCheckboxGroup('d', panel, f => f.day);
    if (key === 'src') buildCheckboxGroup('src', panel, f => f.src, SRC_MAP);
    if (key === 'dst') buildCheckboxGroup('dst', panel, f => f.dst, DST_MAP);
    if (key === 'cat') buildCheckboxGroup('cat', panel, getDisplayCat, CAT_MAP_EXT);
  });
}
function buildCheckboxGroup(key, el, getter, map) {
  el.innerHTML = '';
  const filtered = flows.filter(f => {
    if (filterState.y.size && !filterState.y.has(String(f.year))) return false;
    if (filterState.m.size && !filterState.m.has(String(f.month))) return false;
    if (filterState.d.size) {
      if (f.day == null) return false;
      if (!filterState.d.has(String(f.day))) return false;
    }
    if (filterState.src.size && !filterState.src.has(f.src)) return false;
    if (filterState.dst.size && !filterState.dst.has(f.dst)) return false;
    if (filterState.cat.size && !filterState.cat.has(getDisplayCat(f))) return false;
    return true;
  });

  const set = new Set();
  filtered.forEach(f => {
    const v = getter(f);
    if (key === 'd' && f.day == null) return;
    if (v != null) set.add(String(v));
  });

  [...set].sort().forEach(v => {
    const label = map ? map[v] : v;
    const checked = filterState[key].has(v) ? 'checked' : '';
    el.innerHTML += `
      <label>
        <input type="checkbox" value="${v}" ${checked}
          onchange="onMultiFilterChange('${key}', this)">
        ${label}
      </label><br>
    `;
  });
}
function getDisplayCat(f) {
  if (f.dst === 'e') return f.cat;
  if (f.dst === 'i') return 'income';
  return 'transfer';
}

/*---------------
  渲染分页
---------------*/
function renderPagedContext() {
  const { data, totals, container } = pagedContext;
  const total = data.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (pagedContext.page > totalPages) pagedContext.page = totalPages || 1;
  const page = pagedContext.page;

  let html = '';

  if (!total) {
    container.innerHTML = `<div class="sep"><b>筛选结果:</b><br>无匹配记录</div>`;
    return;
  }
  if (totals) {
    html += `
    <div class="sep"><b>筛选结果:</b><br>
    共 ${total} 条
    收入: <span class="amount positive">${fmt(totals.totalIncome)}</span>
    支出: <span class="amount negative">${fmt(totals.totalExpense)}</span>
    中转: <span class="amount transfer">${fmt(totals.totalTransfer)}</span>
    </div>
    `;
  }

  if (totalPages > 1) {
    html += renderPager(totalPages);
  }

  const start = (page - 1) * PAGE_SIZE;
  const pageData = data.slice(start, start + PAGE_SIZE);
  html += renderFlowTable(pageData, start);

  container.innerHTML = html;
}

/*---------------
  分页导航条
---------------*/
function renderPager(totalPages) {
  if (totalPages <= 1) return '';

  const page = pagedContext.page;
  let html = '';

  html += `<button ${page === 1 ? 'disabled' : ''} onclick="gotoPage(${page - 1})">Prev</button>`;

  const pages = new Set();
  for (let i = 1; i <= EDGE_PAGES; i++) pages.add(i);
  for (let i = totalPages - EDGE_PAGES + 1; i <= totalPages; i++) pages.add(i);

  const half = Math.floor(WINDOW / 2);
  let start = page - half;
  let end = page + half;

  if (start < 1) {
    start = 1;
    end = WINDOW;
  }
  if (end > totalPages) {
    end = totalPages;
    start = totalPages - WINDOW + 1;
  }

  for (let i = start; i <= end; i++) {
    if (i >= 1 && i <= totalPages) pages.add(i);
  }

  const sorted = [...pages].sort((a, b) => a - b);

  let prev = null;
  for (const p of sorted) {
    if (prev && p - prev > 1) {
      html += `<span style="margin:0 4px">…</span>`;
    }
    html += `<button ${p === page ? 'disabled' : ''} onclick="gotoPage(${p})">${p}</button>`;
    prev = p;
  }

  html += `<button ${page === totalPages ? 'disabled' : ''} onclick="gotoPage(${page + 1})">Next</button>`;
  return html;
}
function gotoPage(p) {
  const totalPages = Math.ceil(pagedContext.data.length / PAGE_SIZE);
  if (p < 1 || p > totalPages) return;
  pagedContext.page = p;

  let pages = store[getFileKey('page')] || {};
  pages[pagedContext.id] = p;
  store[getFileKey('page')] = pages;

  renderPagedContext();
}

/*---------------
  填充表
---------------*/
function renderFlowTable(flowList, startIndex = 0) {
  let html = `<table>`;
  html += `
  <tr>
    <th>#</th>
    <th>时间</th>
    <th>来源</th>
    <th>去向</th>
    <th>类别</th>
    <th>金额</th>
    <th>备注</th>
    <th>文件行</th>
  </tr>
  `;

  flowList.forEach((f, idx) => {
    const seq = startIndex + idx + 1;
    const time = f.day
      ? `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`
      : `${f.year}-${String(f.month).padStart(2, '0')}`;
    const src = SRC_MAP[f.src];
    const dst = DST_MAP[f.dst];
    const cat = getDisplayCat(f);
    const catDisplay = cat ? CAT_MAP_EXT[cat] : '中转';

    html += `
    <tr>
      <td style="opacity:.6">${seq}</td>
      <td>${time}</td>
      <td>${src}</td>
      <td>${dst}</td>
      <td>${catDisplay}</td>
      <td>
        <span class="amount ${f.dst === 'e' ? 'expense' : f.dst === 'i' ? 'income' : 'transfer'}">
          ${fmt(f.amount)}
        </span>
      </td>
      <td>${f.note || '-'}</td>
      <td style="opacity:.6">${f.lineNum}</td>
    </tr>`;
  });

  html += `</table>`;
  return html;
}

/*---------------
  趋势图选择器
---------------*/
function initTrendSelector() {
  const monthInput = document.getElementById('trendEnd');
  if (!monthInput) return;

  let maxY = 0, maxM = 0;
  flows.forEach(f => {
    if (f.year > maxY || (f.year === maxY && f.month > maxM)) {
      maxY = f.year; maxM = f.month;
    }
  });

  // 读取属于该文件的趋势参数
  const savedTrend = store[getFileKey('trend')] || {};
  trendState.endYear = savedTrend.endYear || maxY;
  trendState.endMonth = savedTrend.endMonth || maxM;
  trendState.activeCat = savedTrend.activeCat || 'net';

  monthInput.value = `${trendState.endYear}-${String(trendState.endMonth).padStart(2, '0')}`;

  let catSelect = document.getElementById('trendCat');
  if (!catSelect) {
    catSelect = document.createElement('select');
    catSelect.id = 'trendCat';
    catSelect.style.marginLeft = '8px';
    monthInput.after(catSelect);
  }

  function updateCatOptions() {
    const data = collect12MonthData();
    const usedCats = new Set();
    data.forEach(d => {
      Object.entries(d.cats).forEach(([c, v]) => {
        if (v > 0) usedCats.add(c);
      });
    });
    catSelect.innerHTML = '';
    catSelect.append(new Option('净变化', 'net'));
    catSelect.append(new Option('月支出', 'total'));
    [...usedCats].forEach(c => {
      catSelect.append(new Option(CAT_MAP[c], c));
    });
  }

  monthInput.addEventListener('change', () => { 
    if (!monthInput.value) return;
    const [y, m] = monthInput.value.split('-').map(Number);
    trendState.endYear = y; trendState.endMonth = m;
    store[getFileKey('trend')] = { endYear: y, endMonth: m, activeCat: trendState.activeCat };

    updateCatOptions();
    renderTrendChart();
  });
  catSelect.addEventListener('change', () => { 
    trendState.activeCat = catSelect.value || null;
    store[getFileKey('trend')] = { endYear: trendState.endYear, endMonth: trendState.endMonth, activeCat: trendState.activeCat };
    renderTrendChart();
  });

  updateCatOptions();
  catSelect.value = trendState.activeCat; 
}
function collect12MonthData() {
  const cacheKey = trendState.endYear + '-' + trendState.endMonth + '-' + flows.length;
  if (trendState._cacheKey === cacheKey) return trendState._cacheData;

  const months = [];
  let y = trendState.endYear;
  let m = trendState.endMonth;
  for (let i = 0; i < 12; i++) {
    months.unshift({ year: y, month: m });
    m--;
    if (m === 0) { m = 12; y--; }
  }

  const data = months.map(t => {
    const monthFlows = flows.filter(f => f.year === t.year && f.month === t.month);
    const cats = {};
    let net = 0;
    Object.keys(CAT_MAP).forEach(c => { cats[c] = 0; });
    let totalExpense = 0;

    monthFlows.forEach(f => {
      if (f.dst === 'e') {
        cats[f.cat] += f.amount;
        totalExpense += f.amount;
        net -= f.amount;
      }
      if (f.dst === 'i') { net += f.amount; }
    });

    return {
      label: `${String(t.year).slice(-2)}-${String(t.month).padStart(2, '0')}`,
      cats, net, totalExpense
    };
  });

  trendState._cacheKey = cacheKey;
  trendState._cacheData = data;
  return data;
}

/*---------------
  趋势图绘制
---------------*/
function renderTrendChart() {
  const canvas = document.getElementById('trendCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  ctx.setTransform(1,0,0,1,0,0);
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,rect.width,rect.height);

  const W = rect.width;
  const H = rect.height;
  const pad = 40;

  const data = collect12MonthData();
  if (!data.length) return;
  const xs = data.map((_, i) => pad + i*((W-pad*2)/(data.length-1||1)));
  const catMax = Math.max(1, ...data.flatMap(d => [...Object.values(d.cats), d.totalExpense || 0]));
  const yCat = v => H-pad-(v/catMax)*(H-pad*2);
  const netVals = data.map(d=>d.net);
  const netMin = Math.min(...netVals,0);
  const netMax = Math.max(...netVals,0);
  const yNet = v => H-pad-((v-netMin)/(netMax-netMin||1))*(H-pad*2);

  ctx.font='10px sans-serif';
  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(pad,H-pad);
  ctx.lineTo(W-pad,H-pad);
  ctx.stroke();
  
  ctx.fillStyle = COLORS.text;
  ctx.textAlign='center';
  data.forEach((d,i)=>{ ctx.fillText(d.label,xs[i],H-pad+18); });

  const leftAxisColor = trendState.activeCat !=='net' ? COLORS.expense : COLORS.axisIdle;
  const rightAxisColor = trendState.activeCat ==='net' ? COLORS.income : COLORS.axisIdle;
  
  ctx.strokeStyle=leftAxisColor;
  ctx.fillStyle=leftAxisColor;
  ctx.beginPath();
  ctx.moveTo(pad,pad);
  ctx.lineTo(pad,H-pad);
  ctx.stroke();
  for(let i=0;i<=5;i++){
    const v=(catMax/5)*i;
    const y=yCat(v);
    ctx.beginPath(); ctx.moveTo(pad-4,y); ctx.lineTo(pad,y); ctx.stroke();
    ctx.textAlign='right'; ctx.textBaseline='middle'; ctx.fillText(v.toFixed(0), pad-8, y+3);
  }
  ctx.textBaseline='bottom'; ctx.textAlign='right'; ctx.fillText('支出', pad-8, pad-6);

  ctx.strokeStyle=rightAxisColor;
  ctx.fillStyle=rightAxisColor;
  ctx.beginPath();
  ctx.moveTo(W-pad,pad);
  ctx.lineTo(W-pad,H-pad);
  ctx.stroke();
  for(let i=0;i<=5;i++){
    const v=netMin+(netMax-netMin)*(i/5);
    const y=yNet(v);
    ctx.beginPath(); ctx.moveTo(W-pad,y); ctx.lineTo(W-pad+4,y); ctx.stroke();
    ctx.textAlign='left'; ctx.textBaseline='middle'; ctx.fillText(v.toFixed(0), W-pad+8, y);
  }
  ctx.textBaseline='bottom'; ctx.textAlign='left'; ctx.fillText('净变化', W-pad+8, pad-6);

  Object.keys(CAT_MAP).forEach(cat=>{
    const active=trendState.activeCat===cat;
    ctx.beginPath();
    ctx.strokeStyle=active?CAT_COLORS[cat]:COLORS.inactive;
    ctx.lineWidth=active?2.5:1;
    data.forEach((d,i)=>{
      const x=xs[i]; const y=yCat(d.cats[cat]||0);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  });

  const netActive=trendState.activeCat==='net';
  ctx.beginPath();
  ctx.strokeStyle=netActive?COLORS.income:COLORS.inactive;
  ctx.lineWidth=netActive?2.5:1;
  data.forEach((d,i)=>{
    const x=xs[i]; const y=yNet(d.net);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  const totalActive = trendState.activeCat === 'total';
  ctx.beginPath();
  ctx.strokeStyle = totalActive ? COLORS.expense : COLORS.inactive;
  ctx.lineWidth = totalActive ? 2.5 : 1;
  data.forEach((d,i)=>{
    const x = xs[i]; const y = yCat(d.totalExpense || 0);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  if (!canvas._hoverBound) {
    canvas._hoverBound = true;
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      hoverX = e.clientX - rect.left; hoverY = e.clientY - rect.top;
      hoverActive = true; renderTrendChart();
    });
    canvas.addEventListener('mouseleave', () => { hoverActive = false; renderTrendChart(); });
  }

  if (hoverActive && hoverX != null && hoverY != null) {
    ctx.save();
    let activePoints = [];
    let isNet = trendState.activeCat === 'net';
    let isTotal = trendState.activeCat === 'total';
    let cat = trendState.activeCat;
    let pointColor = COLORS.inactive;

    if (isNet) pointColor = COLORS.income;
    else if (isTotal) pointColor = COLORS.expense;
    else if (cat && CAT_COLORS[cat]) pointColor = CAT_COLORS[cat];

    data.forEach((d, i) => {
      let x = xs[i]; let y, val;
      if (isNet) { y = yNet(d.net); val = d.net; }
      else if (isTotal) { y = yCat(d.totalExpense || 0); val = d.totalExpense || 0; }
      else if (cat) { y = yCat(d.cats[cat] || 0); val = d.cats[cat] || 0; }
      if (y !== undefined) activePoints.push({ x, y, val, label: d.label });
    });

    let closest = null; let minDist = 20; 
    activePoints.forEach(p => {
      let dist = Math.hypot(p.x - hoverX, p.y - hoverY);
      if (dist < minDist) { minDist = dist; closest = p; }
    });

    if (closest) {
      ctx.beginPath();
      ctx.moveTo(pad, closest.y); ctx.lineTo(W - pad, closest.y);
      ctx.moveTo(closest.x, pad); ctx.lineTo(closest.x, H - pad);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke();

      ctx.beginPath(); ctx.arc(closest.x, closest.y, 4, 0, Math.PI * 2); ctx.fillStyle = pointColor; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();

      let tipText = `${closest.val.toFixed(2)}`;
      ctx.font = '12px sans-serif';
      let tWidth = ctx.measureText(tipText).width;
      let tX = closest.x - tWidth / 2; let tY = closest.y - 15;

      if (tX < pad) tX = pad;
      if (tX + tWidth > W - pad) tX = W - pad - tWidth;
      if (tY < pad) tY = closest.y + 25;

      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(tX - 6, tY - 12, tWidth + 12, 24);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(tipText, tX, tY + 1);
    } else {
      ctx.beginPath(); ctx.moveTo(pad, hoverY); ctx.lineTo(W - pad, hoverY);
      ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke();
    }
    ctx.restore();
  }
}

/*---------------
  默认视图 
---------------*/
function renderDefaultView() {
  store[getFileKey('view')] = { type: 'default' }; 
  out.innerHTML = '';

  const netAsset = Object.values(stats.accounts).reduce((sum, v) => sum + v, 0);
  const totalIncome = Object.values(stats.years).reduce((a, y) => a + y.income, 0);
  const totalExpense = Object.values(stats.years).reduce((a, y) => a + y.expense, 0);

  out.innerHTML += `<div class="sep"><b>总览:</b><br>`;
  out.innerHTML += `总收: <span class="amount positive">${fmt(totalIncome)}</span> `;
  out.innerHTML += `总支: <span class="amount negative">${fmt(totalExpense)}</span> `;
  out.innerHTML += `余额: <span class="amount ${netAsset >= 0 ? 'positive' : 'negative'}">${fmt(netAsset)}</span> `;
  
  const debt = calcNetDebt(flows);
  let debtText = ""; let debtColor = "axis";
  if (debt.netOwe > 0) {
      debtText = `♂️ 欠 ♀️ ${fmtMain(Math.abs(debt.netOwe))}`; debtColor = "expense";
  } else if (debt.netOwe < 0) {
      debtText = `♀️ 欠 ♂️ ${fmtMain(Math.abs(debt.netOwe))}`; debtColor = "income";
  }
  out.innerHTML += `<span style="color:var(--${debtColor}, ${COLORS[debtColor]});">${debtText}</span>`;
  out.innerHTML += `</div>`;

  out.innerHTML += `<div class="sep"><b>帐户分布:</b><br>`;
  Object.entries(stats.accounts).forEach(([k, v]) => {
    out.innerHTML += `${ACCOUNTS[k]}: <span class="amount ${v >= 0 ? 'positive' : 'negative'}">${fmt(v)}</span><br>`;
  });
  out.innerHTML += `</div>`;

  const catTotals = {}; let totalCatExpense = 0;
  flows.forEach(f => {
    if (f.dst === 'e') { catTotals[f.cat] = (catTotals[f.cat] || 0) + f.amount; totalCatExpense += f.amount; }
  });
  out.innerHTML += `<div class="sep"><b>支出占比:</b><br>`;
  Object.entries(catTotals).sort((a, b) => b[1] - a[1]).forEach(([c, sum]) => {
      const pct = totalCatExpense ? ((sum / totalCatExpense) * 100).toFixed(1) : 0;
      out.innerHTML += `<span>${CAT_MAP[c]}</span> <span class="amount negative">${fmt(sum)}</span> (${pct}%)<br>`;
    });
  out.innerHTML += '</div>';

  out.innerHTML += `
  <div class="sep" id="trend-sep">
    <b>趋势:</b><br><br><select id="trendCat"></select><br>
    <canvas id="trendCanvas" style="width:600px;height:200px"></canvas> 结束月: <input type="month" id="trendEnd"><br>
  </div>
  `;

  out.innerHTML += '<div class="sep"><b>具体年:</b><br>';
  Object.keys(stats.years).sort((a, b) => b - a).forEach(y => {
    out.innerHTML += `<button onclick="renderYear(${y})">${y}年</button>`;
  });
  out.innerHTML += '</div>';

  function renderFilterItems() {
    const FILTER_ITEMS = [
      { key: 'y',   title: '某年', label: '年' }, { key: 'm',   title: '某月', label: '月' },
      { key: 'd',   title: '某日', label: '日' }, { key: 'src', title: '来源', label: '来源' },
      { key: 'dst', title: '去向', label: '去向' }, { key: 'cat', title: '类别', label: '类别' }
    ];
    return FILTER_ITEMS.map(({ key, title, label }) => `
      <div class="filter-item" data-key="${key}">
        <span class="filter-title">${title}</span> <button class="filter-btn" data-label="${label}"> ?  ▾</button>
        <div class="filter-panel"></div>
      </div>
    `).join('');
  }
  out.innerHTML += `
  <div class="sep"><b>筛选:</b>
    <div class="filter-bar">
      ${renderFilterItems()}
      <span class="filter-title">金额</span> 
      ${withTip(`<input id="fa_min" type="number" value="-100000" step="1000" style="width:70px">`, `<div class="tip-row"><span class="tip-cur">区间可反向</span></div>`)}
      -<input id="fa_max" type="number" value="100000" step="1000" style="width:70px">
      <span class="filter-title">备注</span>
      ${withTip(`<input id="fnote" placeholder="正则" style="width:120px">`, `<div class="tip-row"><span class="tip-cur">.</span><span class="tip-val">有备注</span></div><div class="tip-row"><span class="tip-cur">^$</span><span class="tip-val">无备注</span></div>`)}
      <button id="fgo">GO</button> <button id="freset">RST</button>
    </div>
  </div>
  `;

  initTrendSelector();
  renderTrendChart();

  loadFilterState();
  updateFilterOptions();
  ['y', 'm', 'd', 'src', 'dst', 'cat'].forEach(updateFilterButton);
  
  // 恢复属于该文件的筛选激活状态
  if (store[getFileKey('filter')] && store[getFileKey('filter')].active) {
    renderFilteredFlows();
  }
}

/*---------------
  年视图 
---------------*/
function renderYear(y) {
  store[getFileKey('view')] = { type: 'year', y };
  out.innerHTML = '<button onclick="resetFilterState();renderDefaultView();">' + y + '年 | 返回' + '</button>';

  const yData = stats.years[y];
  const net = yData.income - yData.expense;
  const bal = calcBalanceUntil(y);
  const totalBal = Object.values(bal).reduce((a, b) => a + b, 0);

  out.innerHTML += `<div class="sep"><b>总览:</b><br>`;
  out.innerHTML += `净变化: <span class="amount ${net >= 0 ? 'positive' : 'negative'}">${fmt(net)}</span> `;
  out.innerHTML += `年收: <span class="amount positive">${fmt(yData.income)}</span> `;
  out.innerHTML += `年支: <span class="amount negative">${fmt(yData.expense)}</span> `;
  out.innerHTML += `截止余额: <span class="amount ${totalBal >= 0 ? 'positive' : 'negative'}">${fmt(totalBal)}</span>`;
  out.innerHTML += `</div>`;

  out.innerHTML += `<div class="sep"><b>截止帐户分布:</b><br>`;
  Object.entries(bal).forEach(([k, v]) => {
    out.innerHTML += `${ACCOUNTS[k]}: <span class="amount ${v >= 0 ? 'positive' : 'negative'}">${fmt(v)}</span><br>`;
  });
  out.innerHTML += `</div>`;

  let yTotal = Object.values(yData.cats).reduce((a, b) => a + b, 0);
  out.innerHTML += `<div class="sep"><b>支出占比:</b><br>`;
  Object.entries(yData.cats).sort((a, b) => b[1] - a[1]).forEach(([c, sum]) => {
      const pct = yTotal ? ((sum / yTotal) * 100).toFixed(1) : 0;
      out.innerHTML += `${CAT_MAP[c]} <span class="amount negative">${fmt(sum)}</span> (${pct}%)<br>`;
    });
  out.innerHTML += '</div>';

  out.innerHTML += '<div class="sep"><b>具体月:</b><br>';
  Object.keys(yData.months).sort((a, b) => b - a).forEach(m => {
    out.innerHTML += `<button onclick="renderMonth(${y},${m})">${m}月</button>`;
  });
  out.innerHTML += '</div>';

  const flowsWithDay = [];
  for (const m in yData.months) { flowsWithDay.push(...yData.months[m].filter(f => f.day != null)); }
  flowsWithDay.sort((a, b) => a.lineNum - b.lineNum);
  
  if (flowsWithDay.length > 0) {
    out.innerHTML += `<div class="sep"><b>具体日:</b></div>`;
    const box = document.createElement('div'); out.appendChild(box);
    pagedContext = {
      data: flowsWithDay,
      page: store[getFileKey('page')].yearDay || 1,
      totals: null, container: box, id: 'yearDay'
    };
    renderPagedContext();
  }
}

/*---------------
  月视图 
---------------*/
function renderMonth(y, m) {
  store[getFileKey('view')] = { type: 'month', y, m };
  out.innerHTML = '<button onclick="renderYear(' + y + ')">' + y + '年' + m + '月 | 返回</button>';

  const monthAllFlows = flows.filter(f => f.year === y && f.month === m);
  let income = 0, expense = 0, catSum = {};
  monthAllFlows.forEach(f => {
    if (f.dst === 'i') { income += f.amount; } 
    else if (f.dst === 'e') { expense += f.amount; catSum[f.cat] = (catSum[f.cat] || 0) + f.amount; }
  });
  const bal = calcBalanceUntil(y, m);
  const totalBal = Object.values(bal).reduce((a, b) => a + b, 0);

  out.innerHTML += `<div class="sep"><b>总览:</b><br>`;
  out.innerHTML += `净变化: <span class="amount ${(income - expense) >= 0 ? 'positive' : 'negative'}">${fmt((income - expense))}</span> `
  out.innerHTML += `月收: <span class="amount positive">${fmt(income)}</span> `;
  out.innerHTML += `月支: <span class="amount negative">${fmt(expense)}</span> `;
  out.innerHTML += `截止余额: <span class="amount ${totalBal >= 0 ? 'positive' : 'negative'}">${fmt(totalBal)}</span>`;
  out.innerHTML += `</div>`;

  out.innerHTML += `<div class="sep"><b>截止帐户分布:</b><br>`;
  Object.entries(bal).forEach(([k, v]) => {
    out.innerHTML += `${ACCOUNTS[k]}: <span class="amount ${v >= 0 ? 'positive' : 'negative'}">${fmt(v)}</span><br>`;
  });
  out.innerHTML += `</div>`;

  let monthTotal = Object.values(catSum).reduce((a, b) => a + b, 0);
  out.innerHTML += `<div class="sep"><b>支出占比:</b><br>`;
  Object.entries(catSum).sort((a, b) => b[1] - a[1]).forEach(([c, sum]) => {
      const pct = monthTotal ? ((sum / monthTotal) * 100).toFixed(1) : 0;
      out.innerHTML += `${CAT_MAP[c]} <span class="amount negative">${fmt(sum)}</span> (${pct}%)<br>`;
    });
  out.innerHTML += '</div>';

  const monthFlowsWithDay = monthAllFlows.filter(f => f.day).sort((a, b) => a.lineNum - b.lineNum);
  if (monthFlowsWithDay.length > 0) {
    out.innerHTML += `<div class="sep"><b>具体日:</b></div>`;
    const box = document.createElement('div'); out.appendChild(box);
    pagedContext = {
      data: monthFlowsWithDay,
      page: store[getFileKey('page')].monthDay || 1,
      totals: null, container: box, id: 'monthDay'
    };
    renderPagedContext();
  }
}

/*---------------
  期间累计
---------------*/
function calcBalanceUntil(year, month = null) {
  let acc = {}; ACCOUNT_KEYS.forEach(k => acc[k] = 0);
  flows.forEach(f => {
    if (f.year > year) return;
    if (month != null && f.year === year && f.month > month) return;

    if (f.dst === 'i') { acc[f.src] += f.amount; } 
    else if (f.dst === 'e') { acc[f.src] -= f.amount; } 
    else { acc[f.src] -= f.amount; acc[f.dst] += f.amount; }
  });
  return acc;
}

/*---------------
  汇率参考
---------------*/
async function loadFX(retry = 1) {
  if (fxLoaded) return;
  fxLoaded = true;
  try {
    const rates = await fetchFXOnce();
    FX = rates; fxMeta = { source: 'api', approx: false };
    localStorage.setItem(FX_KEY, JSON.stringify({ ts: Date.now(), rates: FX }));
    console.log('[FX] updated from api');
    restoreState(); // 原地状态刷新
  } catch (e) {
    console.warn('[FX] all api failed');
    if (retry > 0) {
      console.log('[FX] retry in 3s...');
      setTimeout(() => { fxLoaded = false; loadFX(retry - 1); }, 3000);
    }
  }
}
async function fetchFXOnce() {
  const tasks = [];
  tasks.push(fetchWithTimeout('https://api.frankfurter.app/latest?from=CNY').then(data => {
    if (!data?.rates?.USD) throw new Error('invalid frankfurter');
    return { CNY: 1, USD: data.rates.USD, EUR: data.rates.EUR, JPY: data.rates.JPY };
  }));
  tasks.push(fetchWithTimeout('https://open.er-api.com/v6/latest/CNY').then(data => {
    if (data?.result !== 'success') throw new Error('invalid er-api');
    return { CNY: 1, USD: data.rates.USD, EUR: data.rates.EUR, JPY: data.rates.JPY };
  }));
  return await Promise.any(tasks);
}
async function fetchWithTimeout(url, ms = 10000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}
function fxSourceLabel() {
  if (fxMeta.source === 'api') return '';
  if (fxMeta.source === 'ls') return '⚠ 汇率来自本地存储';
  return '⚠ 使用预设汇率';
}
function fmtMain(n) { return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtTip(n) {
  const approx = fxMeta.approx ? '≈ ' : ''; const header = fxSourceLabel();
  return `
    ${header ? `<div style="opacity:.7;margin-bottom:4px">${header}</div>` : ''}
    ${Object.entries(FX).map(([c, rate]) => {
        const value = n * rate;
        const text = value.toLocaleString('zh-CN', { style: 'currency', currency: c, currencyDisplay: 'symbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return `<div class="tip-row"><span class="tip-cur">${c}</span><span class="tip-val">${approx}${text}</span></div>`;
      }).join('')}
  `;
}
function fmt(n) { return withTip(fmtMain(n), fmtTip(n)); }
function withTip(innerHTML, tipHTML) { return `<span class="has-tip">${innerHTML}<span class="tip">${tipHTML}</span></span>`; }

/*---------------
  本地环境自动加载及增强交互
---------------*/
if (store.online_flag === "0") {
  currentFilename = "txn.txt"; // 本地环境固定使用默认文件名

  fetch(`../../_build/txn.txt?t=${Date.now()}`)
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(text => {
      console.log("✅ 检测到本地环境，已自动加载 ../../_build/txn.txt");
      loadFX();
      parse(text);
      out.classList.remove("hide");
      document.querySelector('a[download="sample_txn.txt"]').style.display = 'none';
    })
    .catch(err => {
      console.warn("⚠️ 本地自动加载 txn.txt 失败:", err);
    });

  const pointerStyle = document.createElement('style');
  pointerStyle.textContent = `
    #output td:nth-last-child(1) { cursor: pointer; color: #2980b9; text-decoration: underline; transition: color 0.2s; }
    #output td:nth-last-child(1):hover { color: #c0392b; }
    .error-line-link { cursor: pointer; color: #2980b9; text-decoration: underline; font-weight: bold; transition: color 0.2s; }
    .error-line-link:hover { color: #c0392b; }
  `;
  document.head.appendChild(pointerStyle);
  
  document.addEventListener('click', e => {
    const protocol = store.protocol_name;

    // 1. 表格物理行号定位跳转
    const td = e.target.closest('td');
    if (td && td.closest('#output table') && td.cellIndex === 7) {
      const lineText = td.textContent.trim();
      if (lineText && !isNaN(lineText)) {
        window.location.href = `${protocol}://7{${lineText}`;
      }
      return;
    }

    // 2. 纠错错误列表中行号精准穿梭跳转
    const errLink = e.target.closest('.error-line-link');
    if (errLink) {
      const lineText = errLink.dataset.line;
      if (lineText) {
        window.location.href = `${protocol}://7{${lineText}`;
      }
      return;
    }
  });

  // 右键第二象限弹出层 [reload]
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    let menu = document.getElementById('local-context-menu');
    if (menu) menu.remove();

    menu = document.createElement('div');
    menu.id = 'local-context-menu';
    menu.innerHTML = '<div id="local-reload-btn">[reload]</div>';
    menu.style.cssText = `
      position: fixed; z-index: 10000;
      right: ${window.innerWidth - e.clientX + 2}px; bottom: ${window.innerHeight - e.clientY + 2}px;
      background: #333; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3); font-family: monospace; font-size: 14px;
    `;
    
    document.body.appendChild(menu);
    menu.querySelector('#local-reload-btn').addEventListener('click', () => { window.location.reload(); });

    setTimeout(() => {
      document.addEventListener('click', function closeMenu(ev) {
        if (menu && !menu.contains(ev.target)) { menu.remove(); }
        document.removeEventListener('click', closeMenu);
      });
    }, 0);
  });
}