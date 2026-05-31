import os
import subprocess
import sys
from fontTools.ttLib import TTFont

# --- 配置区 ---
INPUT_FONT = "NotoSerifSC-Regular.woff2" # 你的原始字体文件
COMMON_FILE = "3500.txt"                 # 常用3500字列表文件 (UTF-8编码)
CHUNK_SIZE = 200                         # 稀有字每块的大小
OUTPUT_DIR = "../../src/css/font/"       # 拆分后字体和 CSS 的输出目录

# --- 辅助函数：判断中文字符 (覆盖基本区及扩展区) ---
def is_chinese(char_code):
    return (0x4E00 <= char_code <= 0x9FFF or 0x3400 <= char_code <= 0x4DBF or
            0x20000 <= char_code <= 0x2A6DF or 0x2A700 <= char_code <= 0x2B73F or
            0x2B740 <= char_code <= 0x2B81F or 0x2B820 <= char_code <= 0x2CEAF or
            0x2CEB0 <= char_code <= 0x2EBEF or 0x30000 <= char_code <= 0x3134F)

# --- 辅助函数：优化 CSS Unicode Range ---
def format_unicode_range(chars):
    """将字符列表转换为紧凑的 U+XXXX-YYYY 格式"""
    codes = sorted([ord(c) for c in chars])
    if not codes: return ""
    
    ranges = []
    start = codes[0]
    end = codes[0]
    
    for i in range(1, len(codes)):
        if codes[i] == end + 1:
            end = codes[i]
        else:
            if start == end:
                ranges.append(f"U+{start:04X}")
            else:
                ranges.append(f"U+{start:04X}-{end:04X}")
            start = end = codes[i]
    
    # 处理最后一组
    if start == end:
        ranges.append(f"U+{start:04X}")
    else:
        ranges.append(f"U+{start:04X}-{end:04X}")
        
    return ", ".join(ranges)

# --- 核心：调用 fonttools.subset ---
def run_subset(text, out_name):
    txt_path = "temp.txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)
    
    # 使用 sys.executable 调用当前 Python 解释器运行 fonttools.subset
    cmd = [
        sys.executable,
        "-m", 
        "fontTools.subset",
        INPUT_FONT,
        f"--text-file={txt_path}",
        "--flavor=woff2",
        f"--output-file={os.path.join(OUTPUT_DIR, out_name)}",
        "--layout-features=*",  # 关键：保留间距、变体、竖排等所有特性 (作为列表参数时不要加单引号)
        "--desubroutinize",     # 提高兼容性
    ]
    
    # 取消了 shell=True，更安全，且不受环境变量影响
    subprocess.run(cmd, check=True)
    os.remove(txt_path)

def main():
    # 创建输出目录
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    if not os.path.exists(INPUT_FONT):
        print(f"错误：未找到字体文件 {INPUT_FONT}")
        return

    print(f"正在读取字体: {INPUT_FONT}...")
    font = TTFont(INPUT_FONT)
    # 获取字体中所有支持的字符编码
    all_chars = set(chr(code) for code in font.getBestCmap().keys())
    
    # 1. 加载 3500 常用字
    if os.path.exists(COMMON_FILE):
        with open(COMMON_FILE, "r", encoding="utf-8") as f:
            common_set = set(f.read().replace("\n", "").replace(" ", ""))
    else:
        print(f"错误：未找到 {COMMON_FILE} 文件。请提供包含常用字的文本文件。")
        return

    # 2. 逻辑拆分
    print("正在进行字符归类与排序...")
    zh_chars = {c for c in all_chars if is_chinese(ord(c))}
    non_zh_chars = all_chars - zh_chars
    
    common_zh = zh_chars.intersection(common_set)
    rare_zh = sorted(list(zh_chars - common_zh)) # 对稀有字进行排序，便于生成连续的 unicode-range
    
    # 3. 基础包内容：3500常用字 + 所有非中文字符
    base_chars = "".join(list(common_zh) + list(non_zh_chars))
    print(f"生成基础包 (包含 {len(base_chars)} 字符)...")
    run_subset(base_chars, "common.woff2")
    
    css_content = [
        "/* 基础字体包：包含所有非中文字符及常用3500字 */",
        "@font-face {",
        "  font-family: 'Noto Serif SC';",
        "  src: url('./font/common.woff2') format('woff2');",
        "  font-display: swap;",
        "}\n"
    ]

    # 4. 稀有字分块处理
    print(f"开始处理稀有字（共 {len(rare_zh)} 字），每块 {CHUNK_SIZE} 字...")
    for i in range(0, len(rare_zh), CHUNK_SIZE):
        chunk = rare_zh[i : i + CHUNK_SIZE]
        chunk_idx = (i // CHUNK_SIZE) + 1
        file_name = f"rare-{chunk_idx}.woff2"
        
        print(f"  正在生成 {file_name}...")
        run_subset("".join(chunk), file_name)
        
        # 生成优化后的 Unicode 范围
        u_range = format_unicode_range(chunk)
        css_content.append(f"/* 稀有字分块 {chunk_idx} */")
        css_content.append("@font-face {")
        css_content.append("  font-family: 'Noto Serif SC';")
        css_content.append(f"  src: url('./font/{file_name}') format('woff2');")
        css_content.append(f"  unicode-range: {u_range};")
        css_content.append("  font-display: swap;")
        css_content.append("}\n")

    # 5. 保存 CSS 结果
    css_path = os.path.join(OUTPUT_DIR, "font.css")
    with open(css_path, "w", encoding="utf-8") as f:
        f.write("\n".join(css_content))
    
    print(f"\n✅ 处理完成！所有结果已输出到 '{OUTPUT_DIR}' 目录。")
    print(f"🔗 CSS 文件路径: {css_path}")

if __name__ == "__main__":
    main()