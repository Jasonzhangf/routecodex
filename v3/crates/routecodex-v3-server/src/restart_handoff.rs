use crate::restart_closeout::V3FrontTransportCloseoutState;
use crate::V3MetadataCenterExecutionPlan;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, Response};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tower_service::Service;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3FrontExecutionMode {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3FrontContinuationOwner {
    Direct,
    Relay,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct V3FrontRequestLeaseKey {
    pub request_id: String,
    pub pipeline_id: String,
    pub server_id: String,
    pub port: u16,
    pub session_scope: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct V3FrontConnectionIdentity(pub u64);

#[derive(Debug, Clone)]
pub struct V3FrontDeadlineBudget {
    absolute_deadline: Instant,
    idle_deadline: Instant,
}

impl V3FrontDeadlineBudget {
    pub fn new(now: Instant, absolute: Duration, idle: Duration) -> Self {
        Self {
            absolute_deadline: now + absolute,
            idle_deadline: now + idle,
        }
    }

    pub fn remaining(&self, now: Instant) -> (Duration, Duration) {
        (
            self.absolute_deadline.saturating_duration_since(now),
            self.idle_deadline.saturating_duration_since(now),
        )
    }

    pub fn is_expired(&self, now: Instant) -> bool {
        self.absolute_deadline <= now || self.idle_deadline <= now
    }

    pub fn observe_activity(&mut self, now: Instant, idle: Duration) {
        self.idle_deadline = (now + idle).min(self.absolute_deadline);
    }

    pub fn restore_remaining(
        now: Instant,
        absolute_remaining: Duration,
        idle_remaining: Duration,
    ) -> Self {
        Self {
            absolute_deadline: now + absolute_remaining,
            idle_deadline: now + idle_remaining.min(absolute_remaining),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3FrontFrameDecision {
    New,
    Duplicate,
    OutOfOrder,
}

#[derive(Debug, Clone, Default)]
pub struct V3FrontFrameSequence {
    next_client_sequence: u64,
    next_provider_sequence: u64,
}

impl V3FrontFrameSequence {
    pub fn observe_client(&mut self, sequence: u64) -> V3FrontFrameDecision {
        observe_next(&mut self.next_client_sequence, sequence)
    }

    pub fn observe_provider(&mut self, sequence: u64) -> V3FrontFrameDecision {
        observe_next(&mut self.next_provider_sequence, sequence)
    }

    pub fn client_next(&self) -> u64 {
        self.next_client_sequence
    }

    pub fn provider_next(&self) -> u64 {
        self.next_provider_sequence
    }
}

fn observe_next(next: &mut u64, sequence: u64) -> V3FrontFrameDecision {
    match sequence.cmp(next) {
        std::cmp::Ordering::Equal => {
            *next = next.saturating_add(1);
            V3FrontFrameDecision::New
        }
        std::cmp::Ordering::Less => V3FrontFrameDecision::Duplicate,
        std::cmp::Ordering::Greater => V3FrontFrameDecision::OutOfOrder,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3FrontLeaseState {
    Running,
    Frozen,
    Attached,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3FrontCloseoutState {
    Open,
    TerminalSent,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3RuntimeHandoffCheckpoint {
    pub key: V3FrontRequestLeaseKey,
    pub runtime_generation: u64,
    pub execution_mode: V3FrontExecutionMode,
    pub continuation_owner: V3FrontContinuationOwner,
    pub next_client_sequence: u64,
    pub next_provider_sequence: u64,
    pub semantic_commit: bool,
    pub closeout_state: V3FrontCloseoutState,
    pub absolute_remaining_ms: u64,
    pub idle_remaining_ms: u64,
    pub captured_at_epoch_ms: u64,
}

#[derive(Debug, Clone)]
pub struct V3FrontRequestLease {
    pub key: V3FrontRequestLeaseKey,
    pub execution_mode: V3FrontExecutionMode,
    pub continuation_owner: V3FrontContinuationOwner,
    pub runtime_generation: u64,
    pub state: V3FrontLeaseState,
    pub semantic_commit: bool,
    pub closeout_state: V3FrontCloseoutState,
    pub frame_sequence: V3FrontFrameSequence,
    pub deadline: V3FrontDeadlineBudget,
}

impl V3FrontRequestLease {
    pub fn from_execution_mode(
        execution_mode: V3FrontExecutionMode,
        request_id: impl Into<String>,
        pipeline_id: impl Into<String>,
        server_id: impl Into<String>,
        port: u16,
        session_scope: impl Into<String>,
        generation: u64,
        absolute: Duration,
        idle: Duration,
        now: Instant,
    ) -> Self {
        let continuation_owner = match execution_mode {
            V3FrontExecutionMode::Direct => V3FrontContinuationOwner::Direct,
            V3FrontExecutionMode::Relay => V3FrontContinuationOwner::Relay,
        };
        Self {
            key: V3FrontRequestLeaseKey {
                request_id: request_id.into(),
                pipeline_id: pipeline_id.into(),
                server_id: server_id.into(),
                port,
                session_scope: session_scope.into(),
                generation,
            },
            execution_mode,
            continuation_owner,
            runtime_generation: generation,
            state: V3FrontLeaseState::Running,
            semantic_commit: false,
            closeout_state: V3FrontCloseoutState::Open,
            frame_sequence: V3FrontFrameSequence::default(),
            deadline: V3FrontDeadlineBudget::new(now, absolute, idle.min(absolute)),
        }
    }

    /// Build the Front lease from the request-stage execution plan. The
    /// response path must not inspect provider response shape to choose this
    /// mode. The caller must provide the request-ingress pipeline identity;
    /// this constructor never derives it from payload, provider response, or
    /// logs.
    pub fn from_responses_execution_plan(
        plan: &V3MetadataCenterExecutionPlan,
        request_id: impl Into<String>,
        pipeline_id: impl Into<String>,
        server_id: impl Into<String>,
        port: u16,
        session_scope: impl Into<String>,
        generation: u64,
        now: Instant,
    ) -> Self {
        let execution_mode = match plan.decision.mode {
            routecodex_v3_runtime::V3Execution11ProtocolDecisionMode::SameProtocolDirect => {
                V3FrontExecutionMode::Direct
            }
            routecodex_v3_runtime::V3Execution11ProtocolDecisionMode::HubRelay => {
                V3FrontExecutionMode::Relay
            }
        };
        let absolute = Duration::from_millis(plan.decision.target.candidate.request_timeout_ms);
        let idle = Duration::from_millis(
            plan.decision
                .target
                .candidate
                .sse_first_frame_timeout_ms
                .unwrap_or(plan.decision.target.candidate.request_timeout_ms),
        );
        Self::from_execution_mode(
            execution_mode,
            request_id,
            pipeline_id,
            server_id,
            port,
            session_scope,
            generation,
            absolute,
            idle,
            now,
        )
    }

    pub fn checkpoint(&self, now: Instant) -> V3RuntimeHandoffCheckpoint {
        let (absolute, idle) = self.deadline.remaining(now);
        V3RuntimeHandoffCheckpoint {
            key: self.key.clone(),
            runtime_generation: self.runtime_generation,
            execution_mode: self.execution_mode,
            continuation_owner: self.continuation_owner,
            next_client_sequence: self.frame_sequence.client_next(),
            next_provider_sequence: self.frame_sequence.provider_next(),
            semantic_commit: self.semantic_commit,
            closeout_state: self.closeout_state,
            absolute_remaining_ms: absolute.as_millis().min(u64::MAX as u128) as u64,
            idle_remaining_ms: idle.as_millis().min(u64::MAX as u128) as u64,
            captured_at_epoch_ms: v3_front_epoch_ms(),
        }
    }

    pub fn reattach(
        checkpoint: &V3RuntimeHandoffCheckpoint,
        now: Instant,
        new_generation: u64,
    ) -> Self {
        let mut frame_sequence = V3FrontFrameSequence::default();
        frame_sequence.next_client_sequence = checkpoint.next_client_sequence;
        frame_sequence.next_provider_sequence = checkpoint.next_provider_sequence;
        let mut key = checkpoint.key.clone();
        key.generation = new_generation;
        Self {
            key,
            execution_mode: checkpoint.execution_mode,
            continuation_owner: checkpoint.continuation_owner,
            runtime_generation: new_generation,
            state: V3FrontLeaseState::Attached,
            semantic_commit: checkpoint.semantic_commit,
            closeout_state: checkpoint.closeout_state,
            frame_sequence,
            deadline: V3FrontDeadlineBudget::restore_remaining(
                now,
                Duration::from_millis(checkpoint.absolute_remaining_ms),
                Duration::from_millis(checkpoint.idle_remaining_ms),
            ),
        }
    }
}

#[derive(Debug, Default)]
pub struct V3FrontRequestLeaseRegistry {
    leases: BTreeMap<V3FrontRequestLeaseKey, V3FrontLeaseState>,
}

impl V3FrontRequestLeaseRegistry {
    pub fn insert(&mut self, lease: &V3FrontRequestLease) -> Option<V3FrontLeaseState> {
        self.leases.insert(lease.key.clone(), lease.state)
    }

    pub fn state(&self, key: &V3FrontRequestLeaseKey) -> Option<V3FrontLeaseState> {
        self.leases.get(key).copied()
    }

    pub fn remove(&mut self, key: &V3FrontRequestLeaseKey) -> Option<V3FrontLeaseState> {
        self.leases.remove(key)
    }
}

/// Stable Front/Transport Broker state.  Runtime Child code may only receive
/// a checkpoint produced by this broker; it never owns the client socket or
/// reconstructs a lease from payload/log data.
#[derive(Debug, Clone, Default)]
pub struct V3FrontTransportBroker {
    generation: Arc<Mutex<u64>>,
    next_connection_id: Arc<Mutex<u64>>,
    checkpoints: Arc<Mutex<BTreeMap<V3FrontRequestLeaseKey, V3BrokerCheckpoint>>>,
    connection_leases: Arc<Mutex<BTreeMap<V3FrontConnectionIdentity, V3FrontRequestLease>>>,
    front_sockets: Arc<Mutex<BTreeMap<V3FrontConnectionIdentity, V3StableFrontSocket>>>,
    client_sockets: Arc<Mutex<BTreeMap<V3FrontRequestLeaseKey, V3StableFrontSocket>>>,
    client_connections: Arc<Mutex<BTreeMap<V3FrontRequestLeaseKey, V3StableFrontConnection>>>,
}

#[derive(Debug, Clone)]
struct V3BrokerCheckpoint {
    checkpoint: V3RuntimeHandoffCheckpoint,
    captured_at: Instant,
}

impl V3FrontTransportBroker {
    pub fn new(generation: u64) -> Self {
        Self {
            generation: Arc::new(Mutex::new(generation)),
            next_connection_id: Arc::new(Mutex::new(0)),
            checkpoints: Arc::new(Mutex::new(BTreeMap::new())),
            connection_leases: Arc::new(Mutex::new(BTreeMap::new())),
            front_sockets: Arc::new(Mutex::new(BTreeMap::new())),
            client_sockets: Arc::new(Mutex::new(BTreeMap::new())),
            client_connections: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn generation(&self) -> u64 {
        *self
            .generation
            .lock()
            .expect("front broker generation lock")
    }

    pub fn allocate_connection_identity(&self) -> V3FrontConnectionIdentity {
        let mut next = self
            .next_connection_id
            .lock()
            .expect("front broker connection identity lock");
        let identity = V3FrontConnectionIdentity(*next);
        *next = next.saturating_add(1);
        identity
    }

    pub fn register(&self, lease: &V3FrontRequestLease, now: Instant) {
        self.checkpoints
            .lock()
            .expect("front broker checkpoint lock")
            .insert(
                lease.key.clone(),
                V3BrokerCheckpoint {
                    checkpoint: lease.checkpoint(now),
                    captured_at: now,
                },
            );
    }

    pub fn refresh(&self, lease: &V3FrontRequestLease, now: Instant) {
        self.register(lease, now);
    }

    /// Register the accepted client socket before request admission. The
    /// connection identity is only a temporary transport handle; it is moved
    /// under the full request lease by `bind_connection_lease`.
    pub fn register_front_socket(
        &self,
        connection: V3FrontConnectionIdentity,
        socket: V3StableFrontSocket,
    ) -> Result<(), String> {
        let mut sockets = self
            .front_sockets
            .lock()
            .expect("front broker accepted socket lock");
        if sockets.insert(connection, socket).is_some() {
            return Err("front connection identity already has a socket".to_string());
        }
        Ok(())
    }

    pub fn front_socket(
        &self,
        connection: V3FrontConnectionIdentity,
    ) -> Option<V3StableFrontSocket> {
        self.front_sockets
            .lock()
            .expect("front broker accepted socket lock")
            .get(&connection)
            .cloned()
    }

    /// Bind the accepted Front connection to the complete request lease only
    /// after request admission has produced all typed scope components. The
    /// connection identity alone is never a recovery key.
    pub fn bind_connection_lease(
        &self,
        connection: V3FrontConnectionIdentity,
        lease: V3FrontRequestLease,
        now: Instant,
    ) -> Result<(), String> {
        let mut connections = self
            .connection_leases
            .lock()
            .expect("front broker connection lease lock");
        if connections.contains_key(&connection) {
            return Err(
                "front connection identity is already bound to a request lease".to_string(),
            );
        }
        self.register(&lease, now);
        connections.insert(connection, lease);
        if let Some(socket) = self
            .front_sockets
            .lock()
            .expect("front broker accepted socket lock")
            .remove(&connection)
        {
            self.client_sockets
                .lock()
                .expect("front broker client socket lock")
                .insert(
                    connections
                        .get(&connection)
                        .expect("front connection lease inserted")
                        .key
                        .clone(),
                    socket,
                );
        }
        Ok(())
    }

    pub fn connection_lease(
        &self,
        connection: V3FrontConnectionIdentity,
    ) -> Option<V3FrontRequestLeaseKey> {
        self.connection_leases
            .lock()
            .expect("front broker connection lease lock")
            .get(&connection)
            .map(|lease| lease.key.clone())
    }

    pub fn lease_for_connection(
        &self,
        connection: V3FrontConnectionIdentity,
    ) -> Option<V3FrontRequestLease> {
        self.connection_leases
            .lock()
            .expect("front broker connection lease lock")
            .get(&connection)
            .cloned()
    }

    pub fn observe_provider_frame(
        &self,
        key: &V3FrontRequestLeaseKey,
        sequence: u64,
    ) -> Result<V3FrontFrameDecision, String> {
        let mut checkpoints = self
            .checkpoints
            .lock()
            .expect("front broker checkpoint lock");
        let Some(checkpoint) = checkpoints.get_mut(key) else {
            return Err("provider frame lease key is not registered".to_string());
        };
        let decision = observe_next(&mut checkpoint.checkpoint.next_provider_sequence, sequence);
        Ok(decision)
    }

    pub fn freeze(&self, now: Instant) -> Vec<V3RuntimeHandoffCheckpoint> {
        let mut checkpoints = self
            .checkpoints
            .lock()
            .expect("front broker checkpoint lock");
        let mut frozen = Vec::with_capacity(checkpoints.len());
        for entry in checkpoints.values_mut() {
            let elapsed = now.saturating_duration_since(entry.captured_at);
            entry.checkpoint.absolute_remaining_ms = entry
                .checkpoint
                .absolute_remaining_ms
                .saturating_sub(elapsed.as_millis().min(u64::MAX as u128) as u64);
            entry.checkpoint.idle_remaining_ms = entry
                .checkpoint
                .idle_remaining_ms
                .saturating_sub(elapsed.as_millis().min(u64::MAX as u128) as u64);
            entry.captured_at = now;
            frozen.push(entry.checkpoint.clone());
        }
        frozen
    }

    pub fn restore_checkpoints(
        &self,
        checkpoints: &[V3RuntimeHandoffCheckpoint],
        now: Instant,
    ) -> Result<usize, String> {
        self.restore_checkpoints_at(checkpoints, now, v3_front_epoch_ms())
    }

    pub fn restore_checkpoints_at(
        &self,
        checkpoints: &[V3RuntimeHandoffCheckpoint],
        now: Instant,
        restored_at_epoch_ms: u64,
    ) -> Result<usize, String> {
        let next_generation = checkpoints
            .iter()
            .map(|checkpoint| checkpoint.runtime_generation)
            .max()
            .unwrap_or_else(|| self.generation())
            .saturating_add(1);
        let mut stored = self
            .checkpoints
            .lock()
            .expect("front broker checkpoint lock");
        for checkpoint in checkpoints {
            if checkpoint.key.request_id.trim().is_empty()
                || checkpoint.key.pipeline_id.trim().is_empty()
                || checkpoint.key.server_id.trim().is_empty()
                || checkpoint.key.session_scope.trim().is_empty()
            {
                return Err("front handoff checkpoint has incomplete request scope".to_string());
            }
            let mut checkpoint = checkpoint.clone();
            let elapsed_ms = restored_at_epoch_ms.saturating_sub(checkpoint.captured_at_epoch_ms);
            checkpoint.absolute_remaining_ms =
                checkpoint.absolute_remaining_ms.saturating_sub(elapsed_ms);
            checkpoint.idle_remaining_ms = checkpoint.idle_remaining_ms.saturating_sub(elapsed_ms);
            let lease = V3FrontRequestLease::reattach(&checkpoint, now, next_generation);
            stored.insert(
                lease.key.clone(),
                V3BrokerCheckpoint {
                    checkpoint: lease.checkpoint(now),
                    captured_at: now,
                },
            );
        }
        *self
            .generation
            .lock()
            .expect("front broker generation lock") = next_generation;
        Ok(checkpoints.len())
    }

    pub fn reattach(
        &self,
        checkpoint: &V3RuntimeHandoffCheckpoint,
        now: Instant,
    ) -> V3FrontRequestLease {
        let mut generation = self
            .generation
            .lock()
            .expect("front broker generation lock");
        *generation = generation.saturating_add(1);
        let old_key = checkpoint.key.clone();
        let mut checkpoint = checkpoint.clone();
        if let Some(entry) = self
            .checkpoints
            .lock()
            .expect("front broker checkpoint lock")
            .get(&old_key)
        {
            let elapsed = now.saturating_duration_since(entry.captured_at);
            let elapsed_ms = elapsed.as_millis().min(u64::MAX as u128) as u64;
            checkpoint.absolute_remaining_ms =
                checkpoint.absolute_remaining_ms.saturating_sub(elapsed_ms);
            checkpoint.idle_remaining_ms = checkpoint.idle_remaining_ms.saturating_sub(elapsed_ms);
        }
        let lease = V3FrontRequestLease::reattach(&checkpoint, now, *generation);
        let mut checkpoints = self
            .checkpoints
            .lock()
            .expect("front broker checkpoint lock");
        checkpoints.remove(&old_key);
        checkpoints.insert(
            lease.key.clone(),
            V3BrokerCheckpoint {
                checkpoint: lease.checkpoint(now),
                captured_at: now,
            },
        );
        let socket = self
            .client_sockets
            .lock()
            .expect("front broker client socket lock")
            .remove(&old_key);
        if let Some(socket) = socket {
            self.client_sockets
                .lock()
                .expect("front broker client socket lock")
                .insert(lease.key.clone(), socket);
        }
        lease
    }

    pub fn remove(&self, key: &V3FrontRequestLeaseKey) -> Option<V3RuntimeHandoffCheckpoint> {
        self.checkpoints
            .lock()
            .expect("front broker checkpoint lock")
            .remove(key)
            .map(|entry| entry.checkpoint)
    }

    pub fn register_client_connection(&self, connection: V3StableFrontConnection) {
        self.client_connections
            .lock()
            .expect("front broker client connection lock")
            .insert(connection.key(), connection);
    }

    pub fn client_connection(
        &self,
        key: &V3FrontRequestLeaseKey,
    ) -> Option<V3StableFrontConnection> {
        self.client_connections
            .lock()
            .expect("front broker client connection lock")
            .get(key)
            .cloned()
    }

    pub fn remove_client_connection(
        &self,
        key: &V3FrontRequestLeaseKey,
    ) -> Option<V3StableFrontConnection> {
        self.client_connections
            .lock()
            .expect("front broker client connection lock")
            .remove(key)
    }

    pub fn client_socket(&self, key: &V3FrontRequestLeaseKey) -> Option<V3StableFrontSocket> {
        self.client_sockets
            .lock()
            .expect("front broker client socket lock")
            .get(key)
            .cloned()
    }

    pub fn reattach_client_connection(
        &self,
        old_key: &V3FrontRequestLeaseKey,
        lease: V3FrontRequestLease,
    ) -> Result<(), String> {
        let mut connections = self
            .client_connections
            .lock()
            .expect("front broker client connection lock");
        let Some(connection) = connections.remove(old_key) else {
            return Err("front client connection lease key is not registered".to_string());
        };
        if connection.rebind_lease(lease.clone()).is_err() {
            connections.insert(old_key.clone(), connection);
            return Err("front client connection lease scope mismatch".to_string());
        }
        connections.insert(lease.key.clone(), connection);
        Ok(())
    }

    /// Close every accepted client transport before an exec replacement.
    ///
    /// The current lifecycle does not transfer accepted TCP descriptors or
    /// Hyper connection tasks to the replacement process. Leaving them open
    /// would make the new process restore a lease with no owner and leave the
    /// client waiting forever. This is an explicit transport closeout, not a
    /// provider/runtime failure and never enters a business payload.
    pub fn close_active_client_transports(&self) {
        let mut sockets = Vec::new();
        sockets.extend(
            self.front_sockets
                .lock()
                .expect("front broker accepted socket lock")
                .values()
                .cloned(),
        );
        sockets.extend(
            self.client_sockets
                .lock()
                .expect("front broker client socket lock")
                .values()
                .cloned(),
        );
        for socket in sockets {
            socket.close_for_exec_replacement();
        }
    }
}

fn v3_front_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

enum V3StableFrontConnectionCommand {
    SendClientFrame(Vec<u8>),
    DetachRuntime,
    Close(oneshot::Sender<()>),
}

/// Owns the accepted client socket independently from the runtime attachment.
/// Runtime Child code receives only the command handle; it never receives the
/// `TcpStream`. This is the first executable Front skeleton and deliberately
/// has no provider or protocol parsing responsibility.
#[derive(Clone, Debug)]
pub struct V3StableFrontConnection {
    lease: Arc<Mutex<V3FrontRequestLease>>,
    command_tx: mpsc::Sender<V3StableFrontConnectionCommand>,
}

impl V3StableFrontConnection {
    pub fn spawn(stream: TcpStream, lease: V3FrontRequestLease) -> Self {
        let (command_tx, mut command_rx) = mpsc::channel(32);
        tokio::spawn(async move {
            let mut stream = stream;
            while let Some(command) = command_rx.recv().await {
                match command {
                    V3StableFrontConnectionCommand::SendClientFrame(frame) => {
                        if stream.write_all(&frame).await.is_err() {
                            break;
                        }
                        if stream.flush().await.is_err() {
                            break;
                        }
                    }
                    V3StableFrontConnectionCommand::DetachRuntime => {
                        // Detaching the Runtime Child must not close or
                        // otherwise mutate the client connection.
                    }
                    V3StableFrontConnectionCommand::Close(ack) => {
                        let _ = stream.shutdown().await;
                        let _ = ack.send(());
                        break;
                    }
                }
            }
        });
        Self {
            lease: Arc::new(Mutex::new(lease)),
            command_tx,
        }
    }

    pub fn key(&self) -> V3FrontRequestLeaseKey {
        // The lease is immutable in identity for the lifetime of this
        // connection. Callers must use the typed lease key, never payload or
        // session-only recovery.
        self.lease
            .lock()
            .expect("stable front lease lock")
            .key
            .clone()
    }

    fn rebind_lease(&self, lease: V3FrontRequestLease) -> Result<(), String> {
        let mut current = self.lease.lock().expect("stable front lease lock");
        if current.key.request_id != lease.key.request_id
            || current.key.pipeline_id != lease.key.pipeline_id
            || current.key.server_id != lease.key.server_id
            || current.key.port != lease.key.port
            || current.key.session_scope != lease.key.session_scope
            || lease.key.generation <= current.key.generation
        {
            return Err("front client connection lease scope mismatch".to_string());
        }
        *current = lease;
        Ok(())
    }

    pub async fn detach_runtime(&self) -> Result<(), String> {
        self.command_tx
            .send(V3StableFrontConnectionCommand::DetachRuntime)
            .await
            .map_err(|_| "stable front connection is closed".to_string())
    }

    pub async fn send_client_frame(&self, sequence: u64, frame: &[u8]) -> Result<(), String> {
        let decision = self.lease.lock().expect("stable front lease lock");
        if decision.deadline.is_expired(Instant::now()) {
            return Err("stable front request deadline expired".to_string());
        }
        if decision.closeout_state != V3FrontCloseoutState::Open {
            return Err("stable front request is already closed out".to_string());
        }
        let mut lease = decision;
        let frame_decision = lease.frame_sequence.observe_client(sequence);
        drop(lease);
        if frame_decision != V3FrontFrameDecision::New {
            return Err(format!(
                "client frame sequence rejected: {frame_decision:?}"
            ));
        }
        self.command_tx
            .send(V3StableFrontConnectionCommand::SendClientFrame(
                frame.to_vec(),
            ))
            .await
            .map_err(|_| "stable front connection is closed".to_string())
    }

    pub async fn send_client_terminal(&self, sequence: u64, frame: &[u8]) -> Result<(), String> {
        let mut lease = self.lease.lock().expect("stable front lease lock");
        if lease.deadline.is_expired(Instant::now()) {
            return Err("stable front request deadline expired".to_string());
        }
        if lease.closeout_state != V3FrontCloseoutState::Open {
            return Err("stable front terminal closeout already committed".to_string());
        }
        let frame_decision = lease.frame_sequence.observe_client(sequence);
        if frame_decision != V3FrontFrameDecision::New {
            return Err(format!(
                "client frame sequence rejected: {frame_decision:?}"
            ));
        }
        lease.closeout_state = V3FrontCloseoutState::TerminalSent;
        drop(lease);
        self.command_tx
            .send(V3StableFrontConnectionCommand::SendClientFrame(
                frame.to_vec(),
            ))
            .await
            .map_err(|_| "stable front connection is closed".to_string())
    }

    pub async fn close(&self) -> Result<(), String> {
        self.lease
            .lock()
            .expect("stable front lease lock")
            .closeout_state = V3FrontCloseoutState::Closed;
        let (ack_tx, ack_rx) = oneshot::channel();
        self.command_tx
            .send(V3StableFrontConnectionCommand::Close(ack_tx))
            .await
            .map_err(|_| "stable front connection is already closed".to_string())?;
        ack_rx
            .await
            .map_err(|_| "stable front connection close was interrupted".to_string())
    }
}

/// Production Front socket owner for the HTTP adapter.
#[derive(Clone, Debug)]
pub struct V3StableFrontSocket {
    write_tx: mpsc::Sender<Vec<u8>>,
    close_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    closeout_state: Arc<V3FrontTransportCloseoutState>,
}

impl V3StableFrontSocket {
    fn spawn(mut write_half: OwnedWriteHalf) -> Self {
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(32);
        let (close_tx, mut close_rx) = oneshot::channel();
        let closeout_state = V3FrontTransportCloseoutState::new();
        let worker_closeout_state = Arc::clone(&closeout_state);
        tokio::spawn(async move {
            let mut close_requested = false;
            loop {
                tokio::select! {
                    biased;
                    close = &mut close_rx, if !close_requested => {
                        if close.is_ok() {
                            if let Some(frame) = worker_closeout_state.take_frame() {
                                let _ = write_half.write_all(&frame).await;
                                let _ = write_half.flush().await;
                            }
                            break;
                        }
                        close_requested = true;
                    },
                    frame = write_rx.recv() => {
                        let Some(frame) = frame else { break };
                        if write_half.write_all(&frame).await.is_err() {
                            worker_closeout_state.close();
                            break;
                        }
                        if write_half.flush().await.is_err() {
                            worker_closeout_state.close();
                            break;
                        }
                    }
                }
            }
            let _ = write_half.shutdown().await;
        });
        Self {
            write_tx,
            close_tx: Arc::new(Mutex::new(Some(close_tx))),
            closeout_state,
        }
    }

    fn mark_request_started(&self) {
        self.closeout_state.mark_request_started();
    }

    pub(crate) fn set_exec_closeout_frame(&self, frame: Vec<u8>) {
        self.closeout_state.set_frame(frame);
    }

    fn close_for_exec_replacement(&self) {
        self.closeout_state.close_for_exec_replacement();
        self.signal_close();
    }

    fn signal_close(&self) {
        self.closeout_state.signal_socket_close(&self.close_tx);
    }

    fn close(&self) {
        self.closeout_state.close();
        self.signal_close();
    }

    fn is_closed(&self) -> bool {
        self.closeout_state.is_closed()
    }
}

struct V3FrontHttpIo {
    read_half: OwnedReadHalf,
    front_socket: V3StableFrontSocket,
}

impl AsyncRead for V3FrontHttpIo {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.front_socket.is_closed() {
            return std::task::Poll::Ready(Ok(()));
        }
        let result = std::pin::Pin::new(&mut self.read_half).poll_read(cx, buf);
        if matches!(&result, std::task::Poll::Ready(Ok(())) if buf.filled().is_empty())
            || matches!(&result, std::task::Poll::Ready(Err(_)))
        {
            self.front_socket.closeout_state.mark_peer_disconnected();
        }
        result
    }
}

impl AsyncWrite for V3FrontHttpIo {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        data: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if self.front_socket.is_closed() {
            return std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "front socket closed for exec replacement",
            )));
        }
        self.front_socket.closeout_state.mark_response_started();
        let sender = &self.front_socket.write_tx;
        match sender.try_reserve() {
            Ok(permit) => {
                let length = data.len();
                permit.send(data.to_vec());
                std::task::Poll::Ready(Ok(length))
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                cx.waker().wake_by_ref();
                std::task::Poll::Pending
            }
            Err(mpsc::error::TrySendError::Closed(_)) => std::task::Poll::Ready(Err(
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "front socket is closed"),
            )),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

pub async fn serve_v3_front_http_connection<S>(
    stream: TcpStream,
    remote_addr: SocketAddr,
    connection_identity: V3FrontConnectionIdentity,
    front_transport_broker: V3FrontTransportBroker,
    service: S,
) -> Result<(), std::io::Error>
where
    S: Service<Request<Body>, Response = Response<Body>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    S::Future: Future<Output = Result<Response<Body>, Infallible>> + Send + 'static,
{
    let (read_half, write_half) = stream.into_split();
    let front_socket = V3StableFrontSocket::spawn(write_half);
    front_transport_broker
        .register_front_socket(connection_identity, front_socket.clone())
        .map_err(std::io::Error::other)?;
    let request_front_socket = front_socket.clone();
    let hyper_service = hyper::service::service_fn(move |request: hyper::Request<Incoming>| {
        let mut service = service.clone();
        let front_socket = request_front_socket.clone();
        async move {
            front_socket.mark_request_started();
            let (parts, body) = request.into_parts();
            let mut request = Request::from_parts(parts, Body::new(body));
            request.extensions_mut().insert(ConnectInfo(remote_addr));
            request.extensions_mut().insert(connection_identity);
            request.extensions_mut().insert(front_socket);
            service.call(request).await
        }
    });
    let connection = hyper::server::conn::http1::Builder::new().serve_connection(
        TokioIo::new(V3FrontHttpIo {
            read_half,
            front_socket: front_socket.clone(),
        }),
        hyper_service,
    );
    tokio::select! {
        _ = front_socket.closeout_state.wait_peer_disconnected() => {
            front_socket.close();
            Ok(())
        },
        result = connection => {
            if front_socket.closeout_state.is_peer_disconnected() {
                front_socket.close();
            }
            result.map_err(std::io::Error::other)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[path = "../tests/restart_handoff_closeout.rs"]
    mod closeout;

    fn key() -> V3FrontRequestLeaseKey {
        V3FrontRequestLeaseKey {
            request_id: "req-1".into(),
            pipeline_id: "pipe-1".into(),
            server_id: "server-1".into(),
            port: 7777,
            session_scope: "session-1".into(),
            generation: 4,
        }
    }

    fn test_front_socket(write_tx: mpsc::Sender<Vec<u8>>) -> V3StableFrontSocket {
        let (close_tx, _close_rx) = oneshot::channel();
        V3StableFrontSocket {
            write_tx,
            close_tx: Arc::new(Mutex::new(Some(close_tx))),
            closeout_state: V3FrontTransportCloseoutState::new(),
        }
    }

    fn lease(now: Instant) -> V3FrontRequestLease {
        V3FrontRequestLease {
            key: key(),
            execution_mode: V3FrontExecutionMode::Relay,
            continuation_owner: V3FrontContinuationOwner::Relay,
            runtime_generation: 4,
            state: V3FrontLeaseState::Running,
            semantic_commit: false,
            closeout_state: V3FrontCloseoutState::Open,
            frame_sequence: V3FrontFrameSequence::default(),
            deadline: V3FrontDeadlineBudget::new(
                now,
                Duration::from_secs(120),
                Duration::from_secs(15),
            ),
        }
    }
    #[test]
    fn frame_sequence_rejects_duplicate_and_out_of_order_frames() {
        let mut sequence = V3FrontFrameSequence::default();
        assert_eq!(sequence.observe_client(0), V3FrontFrameDecision::New);
        assert_eq!(sequence.observe_client(0), V3FrontFrameDecision::Duplicate);
        assert_eq!(sequence.observe_client(2), V3FrontFrameDecision::OutOfOrder);
        assert_eq!(sequence.observe_client(1), V3FrontFrameDecision::New);
    }
    #[test]
    fn reattach_preserves_mode_owner_commit_and_sequence() {
        let now = Instant::now();
        let mut lease = lease(now);
        assert_eq!(
            lease.frame_sequence.observe_client(0),
            V3FrontFrameDecision::New
        );
        assert_eq!(
            lease.frame_sequence.observe_provider(0),
            V3FrontFrameDecision::New
        );
        lease.semantic_commit = true;
        let checkpoint = lease.checkpoint(now + Duration::from_secs(1));
        let restored = V3FrontRequestLease::reattach(&checkpoint, now + Duration::from_secs(2), 5);
        assert_eq!(restored.execution_mode, V3FrontExecutionMode::Relay);
        assert_eq!(restored.continuation_owner, V3FrontContinuationOwner::Relay);
        assert!(restored.semantic_commit);
        assert_eq!(restored.runtime_generation, 5);
        assert_eq!(restored.key.generation, 5);
        assert_eq!(restored.frame_sequence.client_next(), 1);
        assert_eq!(restored.frame_sequence.provider_next(), 1);
    }
    #[test]
    fn reattach_never_extends_the_absolute_deadline() {
        let now = Instant::now();
        let lease = lease(now);
        let checkpoint = lease.checkpoint(now + Duration::from_secs(119));
        let restored =
            V3FrontRequestLease::reattach(&checkpoint, now + Duration::from_secs(119), 5);
        let (absolute, _) = restored.deadline.remaining(now + Duration::from_secs(120));
        assert!(absolute.is_zero());
    }
    #[test]
    fn registry_is_keyed_by_full_request_scope() {
        let now = Instant::now();
        let lease = lease(now);
        let mut registry = V3FrontRequestLeaseRegistry::default();
        assert_eq!(registry.insert(&lease), None);
        assert_eq!(registry.state(&lease.key), Some(V3FrontLeaseState::Running));
        assert_eq!(
            registry.remove(&lease.key),
            Some(V3FrontLeaseState::Running)
        );
        assert_eq!(registry.state(&lease.key), None);
    }
    #[test]
    fn broker_reattach_increments_generation_without_resetting_deadline() {
        let now = Instant::now();
        let broker = V3FrontTransportBroker::new(4);
        let lease = lease(now);
        broker.register(&lease, now);
        let checkpoint = broker.freeze(now).pop().expect("registered checkpoint");
        assert_eq!(
            broker.observe_provider_frame(&checkpoint.key, 0),
            Ok(V3FrontFrameDecision::New)
        );
        assert_eq!(
            broker.observe_provider_frame(&checkpoint.key, 0),
            Ok(V3FrontFrameDecision::Duplicate)
        );
        let restored = broker.reattach(&checkpoint, now + Duration::from_secs(1));
        assert_eq!(restored.runtime_generation, 5);
        assert_eq!(restored.key.generation, 5);
        assert!(restored
            .deadline
            .remaining(now + Duration::from_secs(120))
            .0
            .is_zero());
    }
    #[test]
    fn broker_binds_front_connection_identity_to_full_request_lease() {
        let now = Instant::now();
        let broker = V3FrontTransportBroker::new(4);
        let connection = broker.allocate_connection_identity();
        let lease = lease(now);

        broker
            .bind_connection_lease(connection, lease.clone(), now)
            .expect("front connection lease binding");

        assert_eq!(broker.connection_lease(connection), Some(lease.key.clone()));
        assert_eq!(
            broker.lease_for_connection(connection).unwrap().key,
            lease.key
        );
    }
    #[test]
    fn broker_rejects_duplicate_front_connection_identity_binding() {
        let now = Instant::now();
        let broker = V3FrontTransportBroker::new(4);
        let connection = broker.allocate_connection_identity();
        let first = lease(now);
        broker
            .bind_connection_lease(connection, first, now)
            .expect("first front connection lease binding");

        let mut second = lease(now);
        second.key.request_id = "req-2".into();
        assert!(broker
            .bind_connection_lease(connection, second, now)
            .is_err());
        assert_eq!(
            broker.connection_lease(connection).unwrap().request_id,
            "req-1"
        );
    }

    #[test]
    fn broker_moves_front_socket_from_connection_identity_to_request_lease() {
        let now = Instant::now();
        let broker = V3FrontTransportBroker::new(4);
        let connection = broker.allocate_connection_identity();
        let lease = lease(now);
        let (write_tx, _write_rx) = mpsc::channel(1);
        let socket = test_front_socket(write_tx);

        broker
            .register_front_socket(connection, socket)
            .expect("front socket registration");
        assert!(broker.front_socket(connection).is_some());

        broker
            .bind_connection_lease(connection, lease.clone(), now)
            .expect("front connection lease binding");

        assert!(broker.front_socket(connection).is_none());
        assert!(broker.client_socket(&lease.key).is_some());
    }
    #[test]
    fn broker_closes_active_client_transports_before_exec_replacement() {
        let broker = V3FrontTransportBroker::new(4);
        let connection = broker.allocate_connection_identity();
        let (write_tx, _write_rx) = mpsc::channel(1);
        let socket = test_front_socket(write_tx);
        broker
            .register_front_socket(connection, socket.clone())
            .expect("front socket registration");

        broker.close_active_client_transports();

        assert!(socket.is_closed());
    }
    #[tokio::test]
    async fn broker_close_finishes_active_tcp_client_before_exec_replacement() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let broker = V3FrontTransportBroker::new(0);
        let connection_identity = broker.allocate_connection_identity();
        let service = axum::Router::new().into_service();
        let accept_broker = broker.clone();
        let accept = tokio::spawn(async move {
            let (stream, remote_addr) = listener.accept().await.unwrap();
            serve_v3_front_http_connection(
                stream,
                remote_addr,
                connection_identity,
                accept_broker,
                service,
            )
            .await
        });

        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        for _ in 0..100 {
            if broker
                .front_sockets
                .lock()
                .expect("front socket registry lock")
                .contains_key(&connection_identity)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(
            broker
                .front_sockets
                .lock()
                .expect("front socket registry lock")
                .contains_key(&connection_identity),
            "accepted client must be registered before restart closeout"
        );

        broker.close_active_client_transports();
        let mut response = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
        )
        .await
        .expect("restart closeout must not leave a half-open client transport")
        .expect("client EOF read must succeed");
        assert!(
            response.is_empty(),
            "no HTTP response should be fabricated by closeout"
        );
        tokio::io::AsyncWriteExt::shutdown(&mut client)
            .await
            .expect("client write half shutdown");
        let _ = accept.await;
    }
    #[test]
    fn broker_reattach_moves_client_socket_to_new_generation_key() {
        let now = Instant::now();
        let broker = V3FrontTransportBroker::new(4);
        let connection = broker.allocate_connection_identity();
        let lease = lease(now);
        let (write_tx, _write_rx) = mpsc::channel(1);

        broker
            .register_front_socket(connection, test_front_socket(write_tx))
            .expect("front socket registration");
        broker
            .bind_connection_lease(connection, lease.clone(), now)
            .expect("front connection lease binding");
        let checkpoint = broker.freeze(now).pop().expect("front checkpoint");

        let restored = broker.reattach(&checkpoint, now + Duration::from_secs(1));

        assert!(broker.client_socket(&lease.key).is_none());
        assert!(broker.client_socket(&restored.key).is_some());
    }
    #[test]
    fn broker_restores_checkpoint_with_new_generation_and_same_deadline_budget() {
        let now = Instant::now();
        let source = V3FrontTransportBroker::new(4);
        let lease = lease(now);
        source.register(&lease, now);
        let checkpoint = source.freeze(now + Duration::from_secs(1));

        let restored = V3FrontTransportBroker::new(4);
        assert_eq!(
            restored.restore_checkpoints_at(
                &checkpoint,
                now + Duration::from_secs(2),
                checkpoint[0].captured_at_epoch_ms + 1_000,
            ),
            Ok(1)
        );
        assert_eq!(restored.generation(), 5);
        let restored_checkpoint = restored.freeze(now + Duration::from_secs(2));
        assert_eq!(restored_checkpoint[0].key.generation, 5);
        assert!(restored_checkpoint[0].absolute_remaining_ms < checkpoint[0].absolute_remaining_ms);
    }
    #[test]
    fn broker_rejects_checkpoint_with_incomplete_request_scope() {
        let now = Instant::now();
        let mut lease = lease(now);
        lease.key.pipeline_id.clear();
        let checkpoint = [lease.checkpoint(now)];
        let restored = V3FrontTransportBroker::new(4);

        assert!(restored.restore_checkpoints(&checkpoint, now).is_err());
        assert!(restored.freeze(now).is_empty());
    }
    #[tokio::test]
    async fn stable_front_keeps_client_socket_open_while_runtime_detaches() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::net::TcpStream::connect(address).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let now = Instant::now();
        let original_lease = lease(now);
        let old_key = original_lease.key.clone();
        let front = V3StableFrontConnection::spawn(server, original_lease.clone());
        let broker = V3FrontTransportBroker::new(original_lease.runtime_generation);
        broker.register_client_connection(front.clone());
        broker.register(&original_lease, now);
        let checkpoint = broker.freeze(now).pop().expect("front checkpoint");
        let restored = broker.reattach(&checkpoint, now + Duration::from_secs(1));
        broker
            .reattach_client_connection(&old_key, restored.clone())
            .unwrap();
        assert!(broker.client_connection(&old_key).is_none());
        let mut mismatched = restored.clone();
        mismatched.key.session_scope = "different-session".into();
        assert!(broker
            .reattach_client_connection(&restored.key, mismatched)
            .is_err());
        assert!(broker.client_connection(&restored.key).is_some());
        let front = broker
            .client_connection(&restored.key)
            .expect("front connection registered in broker");

        front.detach_runtime().await.unwrap();
        front
            .send_client_frame(0, b"data: still-alive\n\n")
            .await
            .unwrap();

        let mut client = client;
        let mut received = [0_u8; 64];
        let read = tokio::time::timeout(
            Duration::from_millis(100),
            tokio::io::AsyncReadExt::read(&mut client, &mut received),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&received[..read], b"data: still-alive\n\n");
        front
            .send_client_terminal(1, b"data: terminal\n\n")
            .await
            .unwrap();
        assert!(front
            .send_client_terminal(2, b"data: duplicate\n\n")
            .await
            .is_err());
        assert!(front
            .send_client_frame(2, b"data: after-terminal\n\n")
            .await
            .is_err());
        front.close().await.unwrap();
    }
    #[tokio::test]
    async fn stable_front_rejects_client_frame_after_absolute_deadline() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let _client = tokio::net::TcpStream::connect(address).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let now = Instant::now();
        let expired = V3FrontRequestLease {
            key: key(),
            execution_mode: V3FrontExecutionMode::Direct,
            continuation_owner: V3FrontContinuationOwner::Direct,
            runtime_generation: 1,
            state: V3FrontLeaseState::Running,
            semantic_commit: false,
            closeout_state: V3FrontCloseoutState::Open,
            frame_sequence: V3FrontFrameSequence::default(),
            deadline: V3FrontDeadlineBudget::new(now, Duration::ZERO, Duration::ZERO),
        };
        let front = V3StableFrontConnection::spawn(server, expired);

        let error = front.send_client_frame(0, b"data: must-not-send\n\n").await;
        assert_eq!(
            error,
            Err("stable front request deadline expired".to_string())
        );
        front.close().await.unwrap();
    }

    #[tokio::test]
    async fn front_http_adapter_preserves_existing_router_service() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let broker = V3FrontTransportBroker::new(0);
        let connection_identity = broker.allocate_connection_identity();
        let expected_identity = connection_identity;
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(
                move |axum::extract::Extension(identity): axum::extract::Extension<
                    V3FrontConnectionIdentity,
                >| async move {
                    assert_eq!(identity, expected_identity);
                    axum::http::StatusCode::NO_CONTENT
                },
            ),
        );
        let accept = tokio::spawn(async move {
            let (stream, remote) = listener.accept().await.unwrap();
            serve_v3_front_http_connection(
                stream,
                remote,
                connection_identity,
                V3FrontTransportBroker::new(0),
                app.into_service(),
            )
            .await
            .unwrap();
        });
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        tokio::io::AsyncWriteExt::write_all(
            &mut client,
            b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut response = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response)
            .await
            .unwrap();
        accept.await.unwrap();
        assert!(String::from_utf8_lossy(&response).contains("204 No Content"));
    }
}
