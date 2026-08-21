use routecodex_v4_skeleton::{plan_hash, SkeletonPlan};
use std::env;
use std::fs;
use std::process::ExitCode;

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let path = args
        .iter()
        .find(|arg| arg.as_str() != "--check")
        .ok_or_else(|| "usage: routecodex-v4-plan-hash <skeleton-plan.json>".to_string())?;
    let source = fs::read_to_string(path).map_err(|error| format!("read {path}: {error}"))?;
    let plan: SkeletonPlan =
        serde_json::from_str(&source).map_err(|error| format!("parse {path}: {error}"))?;
    let computed = plan_hash(&plan);
    if args.iter().any(|arg| arg == "--check") && plan.plan_hash != computed {
        return Err(format!(
            "plan hash mismatch: stored={} computed={computed}",
            plan.plan_hash
        ));
    }
    println!("{computed}");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
