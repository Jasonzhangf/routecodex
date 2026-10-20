use crate::{Args, Command, ServerCommand};
use std::io;

const MANAGED_CHILD_WORKER_STACK_SIZE: usize = 8 * 1024 * 1024;

pub(super) fn build(args: &Args) -> io::Result<tokio::runtime::Runtime> {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    configure(&mut builder, args);
    builder.build()
}

fn configure(builder: &mut tokio::runtime::Builder, args: &Args) {
    if managed_child_worker_stack_size(args).is_some() {
        // The managed child owns the complete nested Direct/Relay completion
        // state machine. Keep its Error/Retry handoff off the default worker
        // stack while leaving the parent CLI runtime unchanged.
        builder.thread_stack_size(MANAGED_CHILD_WORKER_STACK_SIZE);
    }
}

fn managed_child_worker_stack_size(args: &Args) -> Option<usize> {
    matches!(
        args.command,
        Command::Server {
            command: ServerCommand::RunManagedChild { .. }
        }
    )
    .then_some(MANAGED_CHILD_WORKER_STACK_SIZE)
}

#[cfg(test)]
mod tests {
    use super::{build, managed_child_worker_stack_size};
    use crate::Args;
    use clap::Parser;

    #[test]
    fn managed_child_runtime_has_bounded_worker_stack_capacity() {
        let args = Args::try_parse_from([
            "rccv3",
            "server",
            "run-managed-child",
            "--config",
            "config.toml",
        ])
        .expect("managed child args");
        let runtime = build(&args).expect("managed child runtime");

        runtime.block_on(async {
            tokio::spawn(async {
                consume_worker_stack(4);
            })
            .await
            .expect("stack consumer task");
        });
    }

    #[test]
    fn parent_cli_keeps_default_worker_stack() {
        let args = Args::try_parse_from(["rccv3", "server", "restart", "--config", "config.toml"])
            .expect("restart args");
        assert_eq!(managed_child_worker_stack_size(&args), None);
    }

    #[test]
    fn config_argument_value_does_not_select_managed_child() {
        let args = Args::try_parse_from(["rccv3", "status", "--config", "run-managed-child"])
            .expect("status args");
        assert_eq!(managed_child_worker_stack_size(&args), None);
    }

    #[inline(never)]
    fn consume_worker_stack(depth: u8) -> usize {
        let mut page = [0_u8; 512 * 1024];
        page[0] = depth;
        let child = if depth == 0 {
            0
        } else {
            consume_worker_stack(depth - 1)
        };
        child.wrapping_add(page[0] as usize)
    }
}
