pub mod generator;
pub mod html_utils;
pub mod minify;
pub mod synonyms;

use std::time::Instant;

use crate::config::ServerConfig;

/// 全量构建管线：`swamp-server gen`
pub fn run_gen(cfg: &ServerConfig) -> Result<(), String> {
    let t0 = Instant::now();
    println!("[swamp-gen] 开始纯 Rust 站点构建...");

    let mut ledger = minify::IncrementalLedger::load(cfg);

    minify::build_phase1_assets(cfg, &mut ledger)?;
    let _new_ver = generator::run(cfg)?;
    minify::build_phase3_tail(cfg, &mut ledger)?;

    ledger.save()?;
    println!(
        "[swamp-gen] 构建全部完成，总耗时 {:.2}s",
        t0.elapsed().as_secs_f64()
    );
    Ok(())
}
